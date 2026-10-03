# Absurd Money

A double-entry personal finance app built on the end-to-end encrypted
[reeeductio](https://github.com/reeeductio/reeeductio) Spaces API.

Every journal entry is encrypted on the client, signed by whoever posted it, and
hash-chained to its predecessor. The server stores only ciphertext and cannot read amounts,
accounts, or payees. All balances and reports are computed on your own device. You can
share the books with a partner, or hand an accountant a single tax year, and they can verify
the chain themselves instead of trusting an exported CSV.

## Status

Design phase. There is no code yet. See [design/ACCOUNTING.md](design/ACCOUNTING.md) for
the data model and [TODO.md](TODO.md) for the roadmap.

## Planned stack

- TypeScript, Lit 3, Vite, installable PWA
- [reeeductio TypeScript SDK](https://github.com/reeeductio/reeeductio/tree/main/typescript-sdk)
- SQLite-WASM stored in OPFS, as a local projection that can be rebuilt at any time

## Features (planned)

- Chart of accounts, manual entry with any number of splits, and per-account registers
- Statement reconciliation
- CSV import with categorization rules and review before posting
- Envelope budgeting with rollover
- Investments: commodities, lots, and exact cost-basis tracking
- Shared books with per-role capabilities
