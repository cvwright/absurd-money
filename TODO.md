# TODO

Open issues, grouped by milestone, in priority order. An issue is open
if and only if it is listed here. See
[issues/README.md](issues/README.md) for the workflow.

Next ID: 0057

## Milestone 1: Core ledger

- [ ] [0051](issues/0051-change-password.md) Changing the password:
      the server can't replace an OPAQUE registration, so "Change
      password" fails with 409

- [ ] 0039 Measure cold start against a seeded 10k-entry space, on
      desktop and on a phone
- [ ] 0044 Try passkey unlock on iCloud Keychain, Google Password
      Manager, 1Password, and a hardware key, in Safari, Chrome, and
      Firefox; note which return the PRF at creation

## Later

- [ ] [0048](issues/0048-starter-categories.md) Starter income and
      expense categories after setup, and empty-state hints in import
      and the chart
- [ ] [0049](issues/0049-category-inference.md) Suggest categories
      for imported rows: an inference engine and its initial seed
- [ ] 0045 Upgrade `vite-plugin-pwa` to 2.x once a release is at least
      7 days old (2.0.0 was published 2026-10-03); read its breaking
      changes and check the generated service worker
- [ ] 0027 Investments: commodity accounts, lots, derived lot depletion.
      Write the basis-conservation tests first.
- [ ] 0028 Checkpoint writer and cold start from checkpoints
- [ ] 0040 Several tabs: one owns the projection, the others query it
      over `BroadcastChannel` and take over when it closes
- [ ] 0041 Decrypt sync messages in the projection worker, not on the UI
      thread
- [ ] 0029 OFX/QFX import
- [ ] 0047 Manage import rules: list, edit, reorder, and remove them
      (review can only add one, from a row)
- [ ] [0046](issues/0046-regex-rules.md) Richer patterns in import
      rules (regex or ordered fragments), as `ledger/rules` v2
- [ ] 0030 Bank sync as a tool account (SimpleFIN or Plaid). Maybe
      never.
- [ ] [0034](issues/0034-non-extractable-keys.md) Non-extractable
      WebCrypto keys in memory (needs an SDK change)
- [ ] [0031](issues/0031-sharing.md) Sharing: a second family member
      with their own identity and full access
- [ ] 0055 Sharing: the accountant's read-only hand-off of one year,
      with an expiring role (needs 0032)
- [ ] 0032 SDK client constructed from topic keys, for sharing a single
      year (deferred)
- [ ] [0052](issues/0052-sdk-state-head-clock.md) SDK state writes
      fail with 409 when the server's clock is ahead (setting a
      password on a fresh space)