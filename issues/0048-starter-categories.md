# 0048: Starter categories and empty-state guidance

## Context

New books start with an empty chart. Setup (`setup-view`) only creates
or connects the space, and nothing ever creates income or expense
accounts. The only way to add them is the add form on the Accounts
page, whose type selector defaults to Assets.

The result shows up on first import: the review's category picker
(`categories()` in `src/components/import-view.ts`) offers every open
account in the row's commodity, so with no income or expense accounts
it lists only the user's other bank and card accounts. Nothing explains
why, or where to add categories.

## Acceptance criteria

- After a new space is created, the user is offered a short starter
  set of income and expense accounts (for example Salary, Interest,
  Groceries, Dining, Rent, Utilities, Transportation), each of which can
  be unticked, in a chosen commodity. Skipping is allowed.
- The chosen accounts are created in one `ledger/accounts` update, with
  random IDs like any other account.
- The import view's category picker separates income and expense
  accounts from transfer targets (asset and liability), for example
  with `<optgroup>`s.
- When the row's commodity has no open income or expense accounts, the
  import view says so and points to the Accounts page.
- The Accounts page shows a similar hint when the chart has no income
  or expense accounts.

## Notes

- The starter list is UI copy, not a schema. Account names are
  ordinary user data, and nothing depends on them afterwards.
- Connecting to an existing space must not offer the starter set.
