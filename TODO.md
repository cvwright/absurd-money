# TODO

Open issues, grouped by milestone, in priority order. An issue is open if and only if it is
listed here. See [issues/README.md](issues/README.md) for the workflow.

Next ID: 0045

## Milestone 1: Core ledger

- [ ] 0039 Measure cold start against a seeded 10k-entry space, on desktop and on a phone
- [ ] 0044 Try passkey unlock on iCloud Keychain, Google Password Manager, 1Password, and a
  hardware key, in Safari, Chrome, and Firefox; note which return the PRF at creation

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

- [ ] 0024 Envelopes in `ledger/budget`, and allocations on the `budget` topic
- [ ] [0037](issues/0037-reallocation.md) `ledger.reallocation` for moves between envelopes
- [ ] 0025 Budget schedule in `ledger/budget`, with idempotent materialization of allocations
- [ ] 0026 To Be Budgeted calculation, and moving money between envelopes

## Later

- [ ] 0027 Investments: commodity accounts, lots, derived lot depletion. Write the
  basis-conservation tests first.
- [ ] 0028 Checkpoint writer and cold start from checkpoints
- [ ] 0040 Several tabs: one owns the projection, the others query it over
  `BroadcastChannel` and take over when it closes
- [ ] 0041 Decrypt sync messages in the projection worker, not on the UI thread
- [ ] 0029 OFX/QFX import
- [ ] 0030 Bank sync as a tool account (SimpleFIN or Plaid). Maybe never.
- [ ] [0034](issues/0034-non-extractable-keys.md) Non-extractable WebCrypto keys in memory (needs an SDK change)
- [ ] 0031 Sharing: second user, roles, accountant read-only hand-off
- [ ] 0032 SDK client constructed from topic keys, for sharing a single year (deferred)
