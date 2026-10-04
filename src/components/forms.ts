/**
 * Helpers shared by the forms that build entries.
 */

import { parseDecimal, type Decimal } from '@/core/amount.js';
import { ParseError } from '@/core/errors.js';
import { InvalidEntryError } from '@/services/ledger-space.js';
import { InvalidDocError } from '@/services/state-store.js';

/** An error as one line for the user, with every problem when there are several. */
export function errorMessage(err: unknown): string {
  if (err instanceof InvalidEntryError || err instanceof InvalidDocError) return err.problems.join('. ');
  if (err instanceof ParseError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Parses typed text, naming the field in any error. Blank is `undefined`. */
export function amountOf(text: string, minExp: number, field: string): Decimal | undefined {
  if (text.trim() === '') return undefined;
  try {
    return parseDecimal(text, { decimal: '.', minExp });
  } catch (err) {
    if (err instanceof ParseError) throw new ParseError(`${field}: ${err.message}`);
    throw err;
  }
}

/** Orders account paths so children follow their parents, siblings by name. */
export function comparePaths(x: readonly string[], y: readonly string[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i].localeCompare(y[i]);
    if (c !== 0) return c;
  }
  return x.length - y.length;
}
