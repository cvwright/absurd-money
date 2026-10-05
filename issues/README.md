# Issues

Work is tracked in the repo, so it is versioned with the code. A change
that implements an issue also updates its tracking, in the same diff.

## Where things live

- **[TODO.md](../TODO.md)** is the roadmap and the only place status
  lives. An issue is open if and only if it has a line there. Order
  within a section is priority.
- **`issues/NNNN-slug.md`** is optional and holds detail: context,
  acceptance criteria, open questions, and notes. Create one only when
  an issue needs more than its one line. Files are never deleted.
- **[CHANGELOG.md](../CHANGELOG.md)** records what is done, citing issue
  IDs.
- **Specs are not issues.** If an issue produces a lasting document (a
  schema, a policy), the document goes in `design/` and the issue just
  points to it.

## IDs

`0001`, `0002`, and so on, assigned in increasing order and never reused
or renumbered. Take the next ID from the `Next ID` line at the top of
TODO.md, then increment that line. Reordering or regrouping TODO.md
never changes an ID.

## Opening an issue

1. Add `- [ ] NNNN Short title` to the right section of TODO.md, and
   bump `Next ID`.
2. If the issue needs detail, create `issues/NNNN-slug.md` and link the
   ID on its TODO.md line:
   `- [ ] [NNNN](issues/NNNN-slug.md) Short title`.

## Closing an issue

1. Remove its line from TODO.md.
2. Add an entry to CHANGELOG.md under Unreleased, citing the ID.
3. If the issue has a file, append a `## Resolution` section: the date,
   what was done, and anything deferred (as new issue IDs).

Dropping an issue without doing it follows the same steps; the
resolution says why, and the changelog is skipped.

## Issue file template

```markdown
# NNNN: Title

## Context

Why this matters, and links to the relevant parts of design/.

## Acceptance criteria

- …

## Notes

Open questions, decisions made along the way.
```
