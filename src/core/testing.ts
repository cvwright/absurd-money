/**
 * Fixtures shared by the core's tests. Not imported by app code.
 */

import { chartOf } from './chart.js';
import type { AccountId, IsoDate, Label, MsgId } from './ids.js';
import { decodeAccountsDoc } from './messages.js';

const pad = (s: string, n: number) => s.padEnd(n, 'x').slice(0, n);

export const acct = (name: string) => `acct_${pad(name, 20)}` as AccountId;
export const msg = (name: string) => `M${pad(name, 43)}` as MsgId;
export const lbl = (name: string) => pad(name, 20) as Label;
export const day = (s: string) => s as IsoDate;

export const A = {
  checking: acct('checking'),
  visa: acct('visa'),
  groceries: acct('groceries'),
  dining: acct('dining'),
  rent: acct('rent'),
  salary: acct('salary'),
  envGroceries: acct('envGroceries'),
  envDining: acct('envDining'),
  equity: acct('opening'),
  vti: acct('vti'),
  tradingVti: acct('tradingVti'),
  tradingUsd: acct('tradingUsd'),
  gains: acct('gains'),
} as const;

export const accountsDoc = decodeAccountsDoc(
  {
    v: 1,
    rev: 1,
    accounts: {
      [A.checking]: { name: 'Checking', type: 'asset', cur: 'USD', parent: null, budgetable: true },
      [A.visa]: { name: 'Visa', type: 'liability', cur: 'USD', parent: null, budgetable: true },
      [A.groceries]: {
        name: 'Groceries', type: 'expense', cur: 'USD', parent: null, envelope_account: A.envGroceries,
      },
      [A.dining]: { name: 'Dining', type: 'expense', cur: 'USD', parent: null, envelope_account: A.envDining },
      [A.rent]: { name: 'Rent', type: 'expense', cur: 'USD', parent: null, closed_at: '2025-01-01' },
      [A.salary]: { name: 'Salary', type: 'income', cur: 'USD', parent: null },
      [A.envGroceries]: { name: 'Groceries', type: 'equity', cur: 'USD', parent: null, envelope: true },
      [A.envDining]: { name: 'Dining', type: 'equity', cur: 'USD', parent: null, envelope: true },
      [A.equity]: { name: 'Opening', type: 'equity', cur: 'USD', parent: null },
      [A.vti]: { name: 'VTI', type: 'asset', cur: 'VTI', parent: null },
      [A.tradingVti]: { name: 'Trading:VTI', type: 'equity', cur: 'VTI', parent: null },
      [A.tradingUsd]: { name: 'Trading:USD', type: 'equity', cur: 'USD', parent: null },
      [A.gains]: { name: 'Capital gains', type: 'income', cur: 'USD', parent: null },
    },
  },
  '',
);

export const chart = chartOf(accountsDoc);

/** A wire split in USD cents. */
export const usd = (account: AccountId, cents: number, extra: object = {}) => ({
  account,
  amount: String(cents),
  exp: 2,
  cur: 'USD',
  ...extra,
});

/** A wire `ledger.entry`. */
export const entry = (date: string, splits: object[], extra: object = {}) => ({ v: 1, date, splits, ...extra });
