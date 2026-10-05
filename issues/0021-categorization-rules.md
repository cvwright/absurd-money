# 0021: Categorization rules stored in State

## Context

Import rules map a row's merchant text to a payee and a category, so
most categorization happens in review, before anything is posted (see
"Opaque identifiers" and "CSV import, client-side" in
[design/ACCOUNTING.md](../design/ACCOUNTING.md)). They live in one State
document, `ledger/rules` in [design/SCHEMAS.md](../design/SCHEMAS.md),
which is written a few times a year, not per transaction.

As with import profiles (0020), **every Rule field must be settled
before the first rule is written.** The decoder rejects unknown fields,
so a field added later makes older clients fail to read every rule.

## Decisions

### Schema additions

- **`field`** (optional, `"description"` or `"memo"`, default
  `"description"`). 0020 made the profile's `memo` column "available to
  import rules", and the case it was added for is a bank that puts
  "POS PURCHASE" in the description and the merchant in the memo. A
  memo rule never matches a row with no memo.
- **`sign`** (optional, `"positive"` or `"negative"`), against the
  amount as posted to the account. The case is text that is the same in
  both directions, such as `ZELLE` or `VENMO`, where money in is income
  and money out is an expense. Not `debit`/`credit`: the profile already
  uses `debit` for the bank's sense (money out), which is the opposite
  of the posted sign.

Not added: amount ranges, date conditions, regular expressions (whose
syntax differs between engines; see 0046), and rules that set tags or
memos. Any of these needs `v: 2`.

### Matching

- The payee and the category are chosen **separately**, each from the
  first matching rule that sets a usable one. "First match wins" for
  the whole row would make a payee-only rule shadow every category rule
  after it.
- A stale reference (closed or unknown account, another commodity, the
  account being imported into, unknown payee) is passed over for that
  field, and a later rule may choose. A merged payee resolves to its
  target.

### Post-time checks

Only new or changed rules are checked against the chart and payees, so
closing an account that an old rule names doesn't block adding other
rules. Rules may be removed and reordered, since nothing cites a
`RuleId`.

## Acceptance criteria

- `field` and `sign` are in the Rule schema (SCHEMAS.md and the
  decoder) before any rule is written.
- SCHEMAS.md specifies matching, choice, and post-time checks.
- `src/core/rules.ts` has matching, `categorize`, editing helpers, and
  `rulesUpdateProblems`, covered by vitest.
- `LedgerSpace` loads and rewrites `ledger/rules`.

## Resolution

2026-10-04. Done as specified. The UI for creating rules belongs with
review, where a rule is made from a row ("always categorize this"), so
it is part of 0022.
