# 0037: `ledger.reallocation`

## Context

A move between envelopes was two `ledger.allocation` messages, posted separately. If the
second post failed (a network error, or a chain conflict from another device), the move
was left half done: one envelope down, the other never credited, and To Be Budgeted off by
the difference. A move also has a rule an allocation doesn't, that it sums to zero.

Nothing has been posted to the `budget` topic yet, so this can still be fixed in `v: 1`.

Design: [SCHEMAS.md](../design/SCHEMAS.md), `ledger.reallocation`;
[ACCOUNTING.md](../design/ACCOUNTING.md), "Allocations are events; the schedule is
config".

## Acceptance criteria

- `src/core/messages.ts` decodes and encodes `ledger.reallocation`: top-level `cur`, two
  or more legs with distinct `EnvelopeId`s and non-zero amounts, and an optional non-empty
  memo.
- A fold-time validator checks that every leg names an existing envelope in the message's
  `cur` and that the legs sum to zero. A reallocation that fails is ignored whole and
  surfaced.
- The budget fold adds each leg of a valid reallocation to its envelope; To Be Budgeted is
  unchanged by a reallocation.
- Post-time: no leg names a closed envelope.
- Tests for each of the above.

Needs 0038 first, for `EnvelopeId` and `ledger/budget`. The UI for moving money between
envelopes stays with 0026.

## Notes

- Named `ledger.reallocation` to sit beside `ledger.allocation`.
- The design docs were updated when this issue was opened; only the code remains.
- This issue first also made an account's `envelope` flag immutable, since fold-time rules
  depended on it. 0038 moved envelopes out of the chart, which removed the flag.
