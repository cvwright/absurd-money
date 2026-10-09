# 0052: SDK state writes fail when the server's clock is ahead

## Context

Setting a password on a fresh space against the local e2e server fails
every time with `ChainError: HTTP 409`. `Space.enableOpaque` writes two
State messages back to back (`createRole`, then
`grantCapabilityToRole`). Before each write, the SDK's `_setState`
finds the chain head with
`getMessages('state', { from: Date.now(), to: 0, limit: 1 })`, which
uses the client's clock as the upper bound. The server's clock was
running a few tens of milliseconds ahead of the Mac's (it runs in a
Lima VM), so the message it just stamped was "in the future", the
lookup returned nothing, and the second write went out with
`prev_hash: null`. Retrying after half a second works. See
[typescript-sdk/src/client.ts](https://github.com/reeeductio/reeeductio/blob/main/typescript-sdk/src/client.ts).

`Space.postMessage` looks up its head the same way. Any skew of the
client's clock behind the server's can hit this in production too, and
phones' clocks drift.

Our own State and topic writes don't go through these lookups
(`state-store.ts` and `topic-append.ts` track heads and retry), so only
SDK helpers like `enableOpaque` are affected.

## Acceptance criteria

- The SDK finds the newest message without a time bound taken from the
  client's clock (no upper bound, or one from the server).
- `setPassword` on a fresh space passes against the local server
  without a retry. Remove the retry in
  `src/services/ledger-space.e2e.test.ts`.

## Notes

- This is an upstream fix in reeeductio. Until it lands, consider
  retrying `enableOpaque` on `ChainError` in `LedgerSpace.setPassword`;
  it is idempotent.
- The upstream fix is tracked as item 23 in reeeductio's
  [TODO.md](https://github.com/reeeductio/reeeductio/blob/main/TODO.md).
  Revisit this issue once it lands: bump the SDK, check that
  `setPassword` passes without a retry, and remove the retry and any
  interim workaround.
