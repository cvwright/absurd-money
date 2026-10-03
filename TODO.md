# TODO

## Before writing code

These are pinned once and can never change after the first message is posted.

1. Message schemas, each with a `v` field: `ledger.entry`, `ledger.edit`, `ledger.reversal`,
   `ledger.dismiss`, `ledger.allocation`, `ledger.lotadjust`, recon, and checkpoint/close
2. Amount codec: `BigInt` in memory, decimal strings on the wire, explicit exponent per split
3. Rounding policy: direction, scale, and which side absorbs the remainder
4. Normalization algorithm for derived labels (`payee/v1`)
5. Label PRF derivation and namespace strings

## Milestone 1: Core ledger

6. Project scaffold: Lit 3 + Vite PWA, linked to the reeeductio TypeScript SDK
7. Pure-TS core with no DOM or network: codec, labels, validators, folds, and vitest tests
8. Space creation, and loading/saving the chart of accounts document
9. Opening-balances entry
10. Manual entry with N splits, validated before posting
11. Yearly `journal-YYYY` segments and routing
12. Replay into a SQLite-WASM/OPFS projection, with live updates over WebSocket
13. Per-account register, sorted by entry date
14. Reversals
15. `ledger.edit`: recategorization (income/expense accounts only), memo, payee, receipts
16. Period close message and the positional lock rule
17. Retry on `ChainConflictError`

## Milestone 2: Reconciliation

18. Statement reconciliation posted as `recon` events
19. In-progress reconciliation session kept in local storage

## Milestone 3: CSV import

20. CSV parsing and mapping of columns to fields
21. Categorization rules stored in State
22. Staging review, matching against existing entries, and approval
23. Idempotency via `import_id` labels; consumption derived, dismissal via `ledger.dismiss`

## Milestone 4: Envelope budgeting

24. Envelope equity accounts, and allocations on the `budget` topic
25. Budget schedule document, with idempotent materialization of allocations
26. To Be Budgeted calculation, and moving money between envelopes

## Later

27. Investments: commodity accounts, lots, derived lot depletion. Write the
    basis-conservation tests first.
28. Checkpoint writer and cold start from checkpoints
29. OFX/QFX import
30. Bank sync as a tool account (SimpleFIN or Plaid)
31. Sharing: second user, roles, accountant read-only hand-off
32. SDK client constructed from topic keys, for sharing a single year (deferred)
