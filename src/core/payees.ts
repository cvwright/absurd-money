/**
 * The payee list (`ledger/payees` in design/SCHEMAS.md): lookup by ID and by name, adding
 * a payee, and the rules for rewriting the document (0036).
 *
 * Payees are chosen by name. Names match after the `import/v1` normalization (case,
 * Unicode compatibility forms, and runs of whitespace don't count), so typing "blue
 * bottle" picks "Blue Bottle" instead of adding a second payee. A merged payee's name
 * resolves to the payee it was merged into.
 */

import type { PayeeId } from './ids.js';
import type { Payee, PayeesDoc } from './messages.js';
import { normalizeDescription } from './normalize.js';

/**
 * The payee list before its first write. Its `rev` is 0, so the first write is rev 1. It
 * is never written itself.
 */
export const EMPTY_PAYEES: PayeesDoc = { v: 1, rev: 0, payees: {} };

export function payeeOf(doc: PayeesDoc | undefined, id: PayeeId): Payee | undefined {
  return doc && Object.hasOwn(doc.payees, id) ? doc.payees[id] : undefined;
}

/** The payee `id` stands for: the one it was merged into, if any. There are no chains. */
export function resolvePayee(doc: PayeesDoc | undefined, id: PayeeId): PayeeId {
  const into = payeeOf(doc, id)?.merged_into;
  return into && payeeOf(doc, into) ? into : id;
}

/** A payee's name, following its merge. Empty for an unknown payee. */
export function payeeName(doc: PayeesDoc | undefined, id: PayeeId): string {
  return payeeOf(doc, resolvePayee(doc, id))?.name ?? '';
}

/** A typed name as it is stored: trimmed, with each run of whitespace one space. */
export function cleanPayeeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * The payee named `name`, resolved through its merge, or `undefined` if there is none.
 * A payee not merged away wins over a merged one of the same name, and otherwise the
 * lowest ID wins, so every client picks the same one.
 */
export function findPayee(doc: PayeesDoc | undefined, name: string): PayeeId | undefined {
  const key = normalizeDescription(name);
  if (!doc || key === '') return undefined;
  const [best] = (Object.entries(doc.payees) as [PayeeId, Payee][])
    .filter(([, p]) => normalizeDescription(p.name) === key)
    .sort(([x, p], [y, q]) => Number(p.merged_into !== undefined) - Number(q.merged_into !== undefined) || (x < y ? -1 : 1));
  return best && resolvePayee(doc, best[0]);
}

/** The payees to offer: those not merged away, sorted by name. */
export function payeeChoices(doc: PayeesDoc | undefined): { id: PayeeId; name: string }[] {
  return (Object.entries(doc?.payees ?? {}) as [PayeeId, Payee][])
    .filter(([, p]) => p.merged_into === undefined)
    .map(([id, p]) => ({ id, name: p.name }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** `doc` with a new payee `id` named `name`. Throws if `id` is taken or the name is blank. */
export function withPayee(doc: PayeesDoc, id: PayeeId, name: string): PayeesDoc {
  if (Object.hasOwn(doc.payees, id)) throw new Error(`${id} already exists`);
  const clean = cleanPayeeName(name);
  if (clean === '') throw new Error('a payee needs a name');
  return { ...doc, payees: { ...doc.payees, [id]: { name: clean } } };
}

/**
 * Post-time rules for replacing `prev` with `next`: `rev` goes up by one, and no payee is
 * removed. The decoder already rejects merge chains.
 */
export function payeesUpdateProblems(prev: PayeesDoc, next: PayeesDoc): string[] {
  const problems: string[] = [];
  if (next.rev !== prev.rev + 1) problems.push(`rev must be ${prev.rev + 1}`);
  for (const id of Object.keys(prev.payees)) {
    if (!Object.hasOwn(next.payees, id)) problems.push(`${id}: payees are never removed`);
  }
  return problems;
}
