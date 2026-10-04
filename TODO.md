# TODO

Open issues, grouped by milestone, in priority order. An issue is open if and only if it is
listed here. See [issues/README.md](issues/README.md) for the workflow.

Next ID: 0035

## Milestone 1: Core ledger

- [ ] [0033](issues/0033-key-storage-at-rest.md) Keys wrapped at rest, unlocked by passkey (WebAuthn
  PRF) or OPAQUE password
- [ ] 0009 Opening-balances entry
- [ ] 0010 Manual entry with N splits, validated before posting
- [ ] 0011 Yearly `journal-YYYY` segments and routing
- [ ] [0012](issues/0012-projection.md) Replay into a SQLite-WASM/OPFS projection, with live updates over WebSocket
- [ ] 0013 Per-account register, sorted by entry date
- [ ] 0014 Reversals
- [ ] 0015 `ledger.edit`: recategorization (income/expense accounts only), memo, payee,
  receipts
- [ ] 0016 Period close message and the positional lock rule
- [ ] 0017 Retry on `ChainConflictError`

## Milestone 2: Reconciliation

- [ ] 0018 Statement reconciliation posted as `recon` events
- [ ] 0019 In-progress reconciliation session kept in local storage

## Milestone 3: CSV import

- [ ] [0020](issues/0020-csv-parsing.md) CSV parsing and mapping of columns to fields (mapping profiles: see 0023)
- [ ] 0021 Categorization rules stored in State
- [ ] 0022 Staging review, matching against existing entries, and approval
- [ ] [0023](issues/0023-import-idempotency.md) Idempotency via `import_id` labels; consumption derived, dismissal via
  `ledger.dismiss`

## Milestone 4: Envelope budgeting

- [ ] 0024 Envelope equity accounts, and allocations on the `budget` topic
- [ ] 0025 Budget schedule document, with idempotent materialization of allocations
- [ ] 0026 To Be Budgeted calculation, and moving money between envelopes

## Later

- [ ] 0027 Investments: commodity accounts, lots, derived lot depletion. Write the
  basis-conservation tests first.
- [ ] 0028 Checkpoint writer and cold start from checkpoints
- [ ] 0029 OFX/QFX import
- [ ] 0030 Bank sync as a tool account (SimpleFIN or Plaid). Maybe never.
- [ ] [0034](issues/0034-non-extractable-keys.md) Non-extractable WebCrypto keys in memory (needs an SDK change)
- [ ] 0031 Sharing: second user, roles, accountant read-only hand-off
- [ ] 0032 SDK client constructed from topic keys, for sharing a single year (deferred)
