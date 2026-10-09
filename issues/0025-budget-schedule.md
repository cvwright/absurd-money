# 0025: Budget schedule

## Context

0038 put the monthly schedule in `ledger/budget` and built its codec,
and 0005 pinned the `allocation/v1` label. This issue is what was left:
working out which allocations the schedule calls for, posting them
without doubling a month across devices, and a way to edit the
schedule.

Design: [ACCOUNTING.md](../design/ACCOUNTING.md), "Allocations are
events; the schedule is config"; [SCHEMAS.md](../design/SCHEMAS.md),
`ledger/budget` and `ledger.allocation`;
[LABELS.md](../design/LABELS.md), `allocation/v1`.

## Resolution

2026-10-08. Decisions, now stated in SCHEMAS.md:

- A materialized allocation is dated the first of its month.
- Months are backfilled from an envelope's first step. The page asks
  first when a new step starts in a past month.
- A month already materialized keeps what it got. The `idem` names only
  the envelope and month, so editing a past step changes only months
  not yet posted. Fixing an old month is a manual allocation.
- A closed envelope gets nothing, since an allocation to one can't be
  posted. Reopening it backfills the months it was closed, unless a
  zero step covers them.

Done:

- `src/core/schedule.ts`: `stepAt`, `dueAllocations`, and the step
  edits `withStep`, `withoutStep`, and `withSchedule`.
- `src/services/materialize.ts`: check-then-append against a
  `BudgetTopic` seam. It reads the whole topic, folds it for the `idem`s
  already counted, and posts each missing month on the head it read,
  chaining its own posts. A rival post rejects the next one, and the
  topic is read again. It throws, posting nothing, if the fold halts on
  an unknown message type or version.
- `LedgerSpace.materializeSchedule`, sharing one run among concurrent
  callers. `money-app` runs it when the books open; the Budget page
  runs it after each schedule edit.
- Budget page: a Schedule button per open envelope, listing its steps
  with Remove, and a form to set a step's month and monthly amount (zero
  stops allocating). Each envelope shows its current monthly amount and
  the next change.

Not done: books left open across a month boundary don't materialize
the new month until they are reopened or the schedule is edited.
