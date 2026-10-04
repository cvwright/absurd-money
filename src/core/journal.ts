/**
 * The journal document (`ledger/journal` in design/SCHEMAS.md): the years that have a
 * `journal-YYYY` segment. A year is listed before anything is posted to its segment, so a
 * reader that reads every listed segment misses nothing.
 */

import type { JournalDoc } from './messages.js';

/**
 * The journal document before its first write. Its `rev` is 0, so the first write is
 * rev 1. It is never written itself.
 */
export const EMPTY_JOURNAL: JournalDoc = { v: 1, rev: 0, years: [] };

/** `doc` with `year` listed. Returns `doc` itself if it already is. */
export function withYear(doc: JournalDoc, year: number): JournalDoc {
  if (doc.years.includes(year)) return doc;
  return { ...doc, years: [...doc.years, year].sort((a, b) => a - b) };
}

/** Post-time rules for replacing `prev` with `next`: `rev` goes up by one, and no year is removed. */
export function journalUpdateProblems(prev: JournalDoc, next: JournalDoc): string[] {
  const problems: string[] = [];
  if (next.rev !== prev.rev + 1) problems.push(`rev must be ${prev.rev + 1}`);
  for (const y of prev.years) {
    if (!next.years.includes(y)) problems.push(`${y}: years are never removed`);
  }
  return problems;
}
