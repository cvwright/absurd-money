# 0023: Import idempotency for CSV

## Context

Re-importing an overlapping statement must never post anything twice. The design doc keys
idempotency on the institution's `fitid`, stored as `label("staging", fitid)`. OFX files
carry a `fitid`. **Most CSV exports do not.** So CSV needs an import ID synthesized from
the row itself. See "Ingest" in [design/ACCOUNTING.md](../design/ACCOUNTING.md).

## The hard case

```
2026-09-14, BLUE BOTTLE, -5.00
2026-09-14, BLUE BOTTLE, -5.00
```

Two real coffees with identical rows. A key built from `(account, date, amount,
description)` merges them into one transaction. Adding an occurrence counter
(`…|#0`, `…|#1`) keeps them apart, but the counter is relative to the file. An export
for Sept 1–30 and one for Sept 14–Oct 14 both see two rows on the 14th. That's fine, as
long as the counter is computed **within each date** rather than across the file.

The counter also handles a transaction that was missing from an earlier export: one row
on the 14th in the first export and two in the next gives `#0` (already seen) and `#1`
(new). **Pending transactions are what break it.** A pending row often posts later with a
different date, description, or amount (a restaurant tip, a hotel hold), so it gets a
different key and would import twice. No key can fix that. It is the review step's job:
match each new row against recently imported entries in the same account, with nearby
date and amount, and offer "this replaces the pending one", which becomes a reversal plus
the new entry, or simply a dismissal. Safest default: in the mapping profile, skip rows
the bank marks as pending, when the CSV says so.

## Proposal

```
import_id = label("import/v1", "{account}|{date}|{amount}|{norm(description)}|#{n}")
```

- `n` = the 0-based count of earlier rows in the same file with the same
  `(date, amount, normalized description)`.
- When an `fitid` is present (OFX, or a CSV that happens to have one), use
  `label("import/v1", "{account}|fitid|{fitid}")` instead. Never mix the two schemes
  for the same account.
- The account is part of the key, so the same transaction seen from both sides of a
  transfer (checking and the credit card) gets two different labels. Matching the two
  is the job of the review step's existing-entry matcher, not of idempotency.
- Description normalization is a fixed, minimal algorithm (`import/v1`), specified in
  0004. Payees don't depend on it; they have random IDs.

## The flow for client-side CSV (milestone 3)

**Staging is local; the `import-staging` topic is not used (decided).** The staging topic
exists so a tool account can write without being able to read the books. A CSV the user
imports in their own client has no such boundary:

1. Parse the CSV locally, apply the mapping profile, compute an import ID per row.
2. Drop rows whose import ID is already in the projection (posted or dismissed).
3. Review: apply rules, match against existing manual entries, and let the user approve.
4. Approving posts a `ledger.entry` whose split carries `import_id`. Matching a row to a
   split already in the journal posts a `ledger.edit` setting that split's `import_id`.
   Dismissing posts `ledger.dismiss`. See "Import consumption and matching" in
   [design/SCHEMAS.md](../design/SCHEMAS.md).

The original CSV is uploaded as a blob and referenced from the entries, so the source
stays auditable. The `import-staging` topic stays reserved for the tool-account bank
sync (0030).

## CSV mapping profiles (0020 overlaps)

Each bank's export is different. A mapping profile per account records:

- the columns used for date, amount, and description
- the date format
- the sign convention (card exports often show charges as positive)
- whether debit and credit are in separate columns

Profiles live in State, as one document `ledger/import-profiles`, keyed by account ID.

## Acceptance criteria

- Importing the same file twice posts nothing the second time.
- Two overlapping exports post the union, with no duplicates.
- Two identical same-day rows post two entries.
- A test suite covers the cases above, plus a pending row that later changes.
