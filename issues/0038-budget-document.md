# 0038: Envelopes move from `ledger/accounts` to `ledger/budget`

## Context

Envelopes were `equity` accounts in the chart, marked `envelope: true`, but no journal
split ever posts to one: an envelope's balance comes only from allocations and the
spending in its paired expense accounts. In the chart they looked postable, and needed
rules to stop splits landing on them that the budget fold would silently ignore. Their
`envelope` flag was also mutable, though fold-time rules depended on it.

So envelopes, the expense-to-envelope pairing (`spent_from`), the budgetable accounts,
and the monthly schedule now live together in one State document, `ledger/budget`, which
replaces `ledger/budget-schedule`. Envelopes get their own `env_` IDs, which a split cannot
name. Each expense account is spent from at most one envelope; one envelope may fund
several expense accounts.

`ledger/accounts` v1 drops `budgetable`, `envelope`, and `envelope_account`. No space with
real books exists yet, so v1 changes rather than going to v2.

Design: [SCHEMAS.md](../design/SCHEMAS.md), `EnvelopeId`, `ledger/accounts`,
`ledger/budget`, `ledger.allocation`, and checkpoint `EnvelopeBalance`;
[ACCOUNTING.md](../design/ACCOUNTING.md), "Envelopes partition equity" and "Why budget
configuration is its own document"; [LABELS.md](../design/LABELS.md), the `allocation/v1`
input and test vector.

## Acceptance criteria

- `EnvelopeId` in `src/core/ids.ts`, with `newEnvelopeId`.
- The `ledger/accounts` decoder rejects `budgetable`, `envelope`, and `envelope_account`;
  `chartProblems` loses the rules for them.
- A decoder and encoder for `ledger/budget`, and its post-time rules against the chart,
  wired into `LedgerSpace` as a `DocSpec`.
- `ledger.allocation` and checkpoint `EnvelopeBalance` take an `EnvelopeId`, and the
  allocation fold-time rule checks the envelope exists in `ledger/budget` with the same
  `cur`.
- The budget fold (`envelopeAvailable`, `toBeBudgeted`) reads envelopes, `spent_from`, and
  `budgetable` from `ledger/budget`, ignoring and surfacing invalid pairings.
- `allocationLabel` takes an `EnvelopeId`, and the test passes LABELS.md's new vector.
- `isPostable` in `manual.ts` and `isOpeningEquity` in `opening.ts` no longer check for
  envelopes; their tests change to match.
- The test fixtures in `src/core/testing.ts` move envelopes into a `ledger/budget`
  fixture.

Do this before any real books are created, since it changes `ledger/accounts` v1, which
the app already writes.

## Notes

- Left open for 0024: `spent_from` can change, and re-pairing an expense account moves all
  of its past spending to the new envelope. Decide whether that is wanted, or whether
  pairing needs a start date.
