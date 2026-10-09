# 0024: Envelopes and allocations

## Context

0038 moved envelopes into `ledger/budget` and built its codec, its
post-time rules, and the budget fold. This issue is what was left to
make envelopes usable: posting allocations to the `budget` topic, and a
page for managing envelopes and pairings.

Design: [SCHEMAS.md](../design/SCHEMAS.md), `ledger/budget` and
`ledger.allocation`; [ACCOUNTING.md](../design/ACCOUNTING.md),
"Envelope budgeting".

## Notes

- 0038 left open whether re-pairing an expense account should move all
  of its past spending to the new envelope, or whether a pairing needs a
  start date.

## Resolution

2026-10-06. Pairing stays timeless, with no start date. Accounts are
timeless and periods are query windows, and a pairing is the same kind
of fact. A dated pairing would make the envelope fold depend on entry
dates, and on every `ledger.edit` that moves a split between expense
accounts. Moving an account between two envelopes leaves To Be Budgeted
unchanged, since only the split between envelopes moves, and a
reallocation (0037) can put it back. To change where spending goes from
a date on, close the expense account and pair a new one. SCHEMAS.md
states the rule. The budget page shows how much spending moves before a
re-pairing.

Done:

- `allocationPostProblems` in `validate.ts`: the fold-time rules, plus
  the envelope is open. `LedgerSpace.postAllocation` checks it against
  the latest budget and posts to `budget`.
- `withEnvelope`, `withPairing`, and `pairedTo` in `budget.ts`.
- `Projection.available`: each envelope's available balance, over all
  time.
- `budget-view.ts`, the Budget page: add, rename, close, and reopen
  envelopes, pair expense accounts, and allocate. An envelope can't be
  closed while an account is spent from it, and closing one that still
  holds money asks first.

Left for other issues: budgetable accounts and To Be Budgeted (0026,
whose title now includes budgetable accounts), the schedule (0025), and
moves between envelopes (0037, 0026).
