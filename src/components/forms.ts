/**
 * Helpers shared by the forms that build entries, and the views that show amounts.
 */

import { minor, neg, parseDecimal, writerExp, type Amount, type Decimal } from '@/core/amount.js';
import { ParseError } from '@/core/errors.js';
import type { AccountType } from '@/core/messages.js';
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

/**
 * An amount for display, at the commodity's minor unit or finer if it needs more digits.
 * Exact: it formats the `bigint`, never a float.
 */
export function formatAmount(a: Amount): string {
  const w = writerExp(a, minor(a.cur));
  const negative = w.amount < 0n;
  const digits = (negative ? -w.amount : w.amount).toString().padStart(w.exp + 1, '0');
  const int = digits.slice(0, digits.length - w.exp);
  const frac = digits.slice(digits.length - w.exp);
  return (negative ? '−' : '') + int + (frac ? `.${frac}` : '');
}

/** Types whose balances are normally credits, shown with the sign flipped. */
const CREDIT_NORMAL: ReadonlySet<AccountType> = new Set(['liability', 'equity', 'income']);

/** An amount posted to an account of `type`, signed the way that type is shown. */
export function shownAs(type: AccountType, a: Amount): Amount {
  return CREDIT_NORMAL.has(type) ? neg(a) : a;
}
