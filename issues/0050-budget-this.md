# 0050: "Budget this" on an expense account

## Context

Most envelopes fund exactly one expense account with the same name.
Today that takes two steps on the Budget page: add the envelope, then
pair the account with it. Envelopes and expense accounts stay separate
(see [0024](0024-envelopes.md)), because one envelope can fund several
accounts, some envelopes save up with no account yet, and some accounts
are never budgeted. But the one-to-one case should feel like one thing.

Design: [SCHEMAS.md](../design/SCHEMAS.md), `ledger/budget`;
[ACCOUNTING.md](../design/ACCOUNTING.md), "Envelopes partition equity".

## Acceptance criteria

- Each expense account has a "Budget this" checkbox, on the chart and
  in the Budget page's spending table. It is checked when the account
  is spent from an envelope.
- Checking it on an unpaired account creates an envelope with the
  account's name and `cur` and pairs the account with it, in one
  `ledger/budget` write.
- Unchecking it removes the pairing, after saying how much spending
  leaves the envelope (as re-pairing does now). The envelope stays, and
  the confirmation offers to close it if nothing else is spent from it
  and it holds nothing.
- On the Budget page, an envelope that funds exactly one account, with
  the same name, shows as one row. Envelopes that fund several accounts
  or none show as they do now.
- A pure helper in `src/core/budget.ts` builds the write, with tests.
  Nothing in the schema changes.

## Notes

- If an open, unpaired envelope with the same name and `cur` already
  exists, checking the box should probably pair with it rather than
  create a second one. Decide while building.
- Renaming the account doesn't rename its envelope. Maybe the combined
  row offers to rename both.
- 0048's starter categories could come already budgeted this way.

## Resolution

2026-10-08. `withOwnEnvelope`, `withoutEnvelope`, and `soleAccount` in
`budget.ts`, with tests. The checkbox and its confirmations are shared
by the chart and the Budget page (`components/budget-this.ts`).

Decisions:

- Checking the box pairs with an existing envelope when one is open,
  has the account's name and `cur`, and funds nothing; the first by ID
  if several do. Otherwise it adds a new one. A new envelope takes on
  the account's past spending, so a nonzero balance is confirmed first,
  as re-pairing is.
- "One row" means the envelope list: such an envelope's hint says it is
  the envelope and expense account, rather than "Spent from by" its own
  name. The account keeps its line in the Spending table, which is
  where its checkbox is.
- Renaming that combined row renames the envelope and then the
  account, as two writes. Renaming the account on the chart still
  leaves the envelope's name alone, so the two show separately again.
- Whether the envelope "holds nothing" after unchecking is judged by
  what it will have available once the account's spending no longer
  counts against it.
