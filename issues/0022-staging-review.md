# 0022: Staging review, matching, and approval

## Context

The review step of "CSV import, client-side" in
[design/ACCOUNTING.md](../design/ACCOUNTING.md): a statement is read
with the account's profile (0020), labeled and filtered (0023),
categorized by rules (0021), matched against the journal, and approved.
Matching is "Import consumption and matching" in
[design/SCHEMAS.md](../design/SCHEMAS.md).

Already in place: `readStatement`, `LedgerSpace.labelRows`,
`Projection.consumed`, `freshRows`, `categorize`, `postDismissals`, and
`import_ids` edits through `postEdits`.

## Decisions

- **The profile editor is part of this issue** (decided 2026-10-05).
  Nothing can be imported without a profile, and nothing writes
  `ledger/import-profiles` yet. That means `LedgerSpace` load and update
  for the document, with post-time checks, and a mapping form in the
  import view: header preview, column choice, date format, sign, and
  encoding.

## Still to do

- The matcher: unconfirmed splits (no effective `import_id`) on the
  same account, with the same amount and a nearby date. That covers the
  other side of a transfer and an entry made by hand. Accepting posts an
  `import_ids` edit, or a dismissal if the split's segment is frozen.
- Pending rows that post changed (0023): "this replaces the pending
  one", as a reversal plus a new entry, or a dismissal.
- Approval posts a `ledger.entry` per row, carrying `import_id` and a
  `source` blob of the raw file, uploaded once per import.
- Making a rule from a row ("always categorize this"), deferred here
  from 0021.
- Showing the skipped and flagged rows from `readStatement`.

## Acceptance criteria

- A file can be imported into an account with no profile yet, by
  creating one in the import view.
- Review shows only fresh rows, with the rules' payee and category, and
  the matches it found.
- Approving, matching, and dismissing post what SCHEMAS.md says, and a
  second import of the same file shows nothing.
