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

## Resolution

2026-10-05. Done, with the profile editor.

- **Profiles.** `src/core/import-profiles.ts` has the post-time rules,
  now in SCHEMAS.md: no profile is removed, a profile never changes
  scheme, and only open asset and liability accounts get one. It also
  warns which changes relabel rows already imported
  (`relabelWarnings`), and holds the editor's draft (`draftProfile`,
  `profileDraft`) and the first guess for a new file (`guessDraft`,
  `guessEncoding`). `LedgerSpace` loads and rewrites
  `ledger/import-profiles`.
- **Suggestions.** `src/core/review.ts` matches each row to an
  unconfirmed split with the same amount by value within 7 days, each
  split at most once and closest dates first (`findMatches`). It
  suggests a pending replacement (`findReplacements`): an imported split
  dated within the file whose label the file no longer lists, with the
  row's sign, closest date and then closest amount. It also builds the
  entry (`importEntry`). `Projection.importSplits` supplies the
  candidates.
- **Approval.** `src/services/import-review.ts` posts each decision:
  dismissals, then match edits (a dismissal instead when the matched
  entry's segment is frozen), then entries. The file is uploaded once
  as every entry's `source`, and each new payee is added once. A
  replacement reverses the pending entry, then posts the row with
  `replaces`. One failed row doesn't stop the rest, and rows another
  device handled meanwhile are skipped. It is tested against fakes.
- **UI.** An Import page (`import-view.ts`, with `profile-editor.ts`)
  picks the account and file, edits the profile, and shows rows already
  imported, skipped, and flagged. Each new row gets Add, Match, Replace
  pending, or Dismiss, with a category and payee from the rules. A rule
  can be made from a row, and applies at once to rows not changed by
  hand. Unticked rows and rows with no category are left for later.

Not done: review isn't kept across page loads, since re-reading the file
recovers everything that matters. Managing rules beyond adding one is
0047. The views were built and type-checked, but not exercised in a
browser against a server.
