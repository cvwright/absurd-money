/**
 * Reading and rewriting State documents (design/SCHEMAS.md, "State documents") with
 * compare-and-swap.
 *
 * Every State write in a space shares one chain, so the CAS token is that chain's head.
 * An update reads the head *before* the document, then posts with the head as
 * `prev_hash`. Any write that lands in between, to this path or any other, moves the head
 * and the post is rejected, so an edit is never applied to a stale document.
 *
 * This module knows nothing about the SDK; `StateBackend` is the seam, which keeps the
 * CAS logic testable without a server.
 */

import { CodecError } from '@/core/errors.js';
import { parseJsonBytes } from '@/core/json.js';
import { decodeState, encodeState, type StateDocs, type StatePath } from '@/core/messages.js';

export interface StateBackend {
  /** The newest message hash on the state chain, or null if the chain is empty. */
  head(): Promise<string | null>;
  /** The decrypted bytes at `path`, or null if nothing was ever written there. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes `data` at `path`. Throws `StaleHeadError` if `prevHash` is not the head. */
  write(path: string, data: Uint8Array, prevHash: string | null): Promise<void>;
}

/** A chain (State's, or a topic's) moved between reading its head and posting. */
export class StaleHeadError extends Error {
  constructor() {
    super('the chain changed before the write landed');
    this.name = 'StaleHeadError';
  }
}

/** An update kept losing the race for the state chain, and gave up. */
export class StateConflictError extends Error {
  constructor(readonly path: string, attempts: number) {
    super(`${path}: still conflicting after ${attempts} attempts`);
    this.name = 'StateConflictError';
  }
}

/** An edit produced a document that breaks the post-time rules. Nothing was written. */
export class InvalidDocError extends Error {
  constructor(readonly path: string, readonly problems: readonly string[]) {
    super(`${path}: ${problems.join('; ')}`);
    this.name = 'InvalidDocError';
  }
}

export interface DocSpec<P extends StatePath> {
  readonly path: P;
  /** The document before its first write, with `rev` 0. */
  readonly empty: StateDocs[P];
  /** Post-time rules for replacing `prev` with `next`. Empty means valid. */
  problems(prev: StateDocs[P], next: StateDocs[P]): string[];
}

const MAX_ATTEMPTS = 5;

/** The current document, or the spec's empty document if it was never written. */
export async function loadDoc<P extends StatePath>(
  backend: StateBackend,
  spec: DocSpec<P>,
): Promise<StateDocs[P]> {
  const bytes = await backend.read(spec.path);
  if (bytes === null) return spec.empty;
  // State has no delete, only a write of empty data. A document that is cited forever
  // must never be deleted, so treat that as corruption rather than starting over at rev 1.
  if (bytes.length === 0) throw new CodecError(`${spec.path} was deleted`);
  return decodeState(spec.path, parseJsonBytes(bytes));
}

/**
 * Applies `edit` to the current document and writes the result as the next revision.
 * `edit` gets a fresh document on every attempt, so it must be a pure function of it; it
 * may throw to abort. `rev` is set here, not by `edit`. Returns the document written.
 *
 * If `edit` returns the document it was given, nothing needs to change: nothing is
 * written, and that document is returned.
 */
export async function updateDoc<P extends StatePath>(
  backend: StateBackend,
  spec: DocSpec<P>,
  edit: (doc: StateDocs[P]) => StateDocs[P],
): Promise<StateDocs[P]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const head = await backend.head();
    const prev = await loadDoc(backend, spec);
    const edited = edit(prev);
    if (edited === prev) return prev;
    const next = { ...edited, rev: prev.rev + 1 } as StateDocs[P];
    const problems = spec.problems(prev, next);
    if (problems.length > 0) throw new InvalidDocError(spec.path, problems);
    const data = new TextEncoder().encode(encodeState(spec.path, next));
    try {
      await backend.write(spec.path, data, head);
      return next;
    } catch (err) {
      if (!(err instanceof StaleHeadError)) throw err;
    }
  }
  throw new StateConflictError(spec.path, MAX_ATTEMPTS);
}
