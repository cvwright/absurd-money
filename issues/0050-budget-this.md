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
