# Labels

This is the keyed PRF behind every derived identifier: the key derivation, the `label`
function, its output encoding, and the registry of namespaces with the exact input each one
hashes. Why paths need labels at all, and when to derive an ID rather than randomize it, is
in "Opaque identifiers" in [ACCOUNTING.md](ACCOUNTING.md). Issue 0005.

**All of this is pinned for the life of a space.** A label is only useful if every client,
on every device and in every future version, computes the same one. Changing the derivation
changes every label in the space: import rows stop being recognized and post again,
materialized allocations post twice, and Data written under the old labels is orphaned. A
change to how one namespace builds its input needs a new namespace version (`import/v2`).
A change to the derivation itself is label rotation, an open question in ACCOUNTING.md, and
would need a new purpose string for `label_key`.

## Derivation

```
label_key    = HKDF-SHA256(ikm = symmetric_root, salt = none, info = "label key | {space_id}", L = 32)
ns_key(ns)   = HKDF-SHA256(ikm = label_key,      salt = none, info = "label key | {ns}",       L = 32)
label(ns, s) = base64url(HMAC-SHA256(key = ns_key(ns), msg = UTF-8(s))[0:15])
```

| Piece | Pinned value |
|---|---|
| KDF | HKDF-SHA256 (RFC 5869), as the SDK's `deriveKey` / `derive_key` ([TypeScript](https://github.com/reeeductio/reeeductio/blob/main/typescript-sdk/src/crypto.ts#L72-L75), [Python](https://github.com/reeeductio/reeeductio/blob/main/python-sdk/reeeductio/crypto.py#L326-L349)). Both SDKs call it directly, so `label_key` is `deriveKey(symmetricRoot, …)`. |
| Salt | None. RFC 5869 then uses 32 zero bytes. Passing an empty salt gives the same result. |
| Output length | 32 bytes for both keys. |
| `symmetric_root` | The space's 32-byte root, the same one the SDK client is constructed from. |
| `space_id` | The 44-character space ID string (`S…`), exactly as the SDK uses it in `message key \| {space_id}` ([`client.ts`](https://github.com/reeeductio/reeeductio/blob/main/typescript-sdk/src/client.ts#L124)). |
| Info strings | UTF-8. The separator is space, `\|` (U+007C), space, as in the SDK's own `"<purpose> \| <scope>"` strings. |
| MAC | HMAC-SHA256 (RFC 2104) under `ns_key(ns)`, over the UTF-8 bytes of `s`. |
| Truncation | The **first** 15 bytes of the 32-byte tag. |
| Encoding | base64url (RFC 4648 §5) with no padding. 15 bytes is always exactly 20 characters, matching the `Label` type in [SCHEMAS.md](SCHEMAS.md): `^[A-Za-z0-9_-]{20}$`. |

`label_key` is a sibling of the SDK's `message key` and `data key`: a different purpose
under the same root, so it reveals nothing about them and they reveal nothing about it.
Its scope is the space ID, so the same input in two spaces gives unlinkable labels. Each
namespace gets its own key, so a label in one namespace can't be correlated with, or used
to test guesses in, another.

A segment reader (an accountant holding one year's topic key) never holds `label_key` and
never needs it. Labels appear in entries only as opaque values to compare or to look up.
See rule 2 under "SDK client from topic keys" in ACCOUNTING.md.

### Input rules

- **`label` does no normalization.** Each namespace builds `s` and normalizes only the
  user-derived fields in it. See the registry below.
- **`s` must be well-formed.** A JavaScript string with a lone surrogate is rejected with
  an error, never encoded. `TextEncoder` would silently turn it into U+FFFD while other
  languages refuse to encode it, so two clients could disagree. Where user text can
  contain one, the namespace's own normalization replaces it first, as `import/v1` does.
- **`s` may be empty.** HMAC is defined for an empty message (see the vectors). No
  registered namespace produces one, but `label` doesn't need to special-case it.
- **`ns` must be registered.** A namespace not listed below is an error. It is
  `{name}/v{n}`: `name` matches `^[a-z0-9-]+$` and `n` is a positive decimal integer
  with no leading zeros, so the info string is plain ASCII.

### Implementation

The keys are derived once per session and held in memory only. They are never written to
OPFS, SQLite, or local storage, since they can always be derived again from the root the
client already holds. The core exposes one function per namespace that builds `s` from
typed fields, rather than `label(ns, s)` with a free-form string, so a caller can't
assemble an input by hand.

The derivation is synchronous with `@noble/hashes`, which the SDK already depends on.
WebCrypto's HKDF and HMAC give the same bytes and are fine too.

### TypeScript surface

For 0007 to implement in `src/core/`. Names are a suggestion; behavior is the spec above.

```ts
deriveLabelKeys(symmetricRoot: Uint8Array, spaceId: string): LabelKeys  // all ns_keys, once

importLabel(keys: LabelKeys, input: string): Label   // input from importInputRow / importInputFitid
allocationLabel(keys: LabelKeys, envelope: AccountId, month: string): Label
reconSessionLabel(keys: LabelKeys, account: AccountId): Label
priceLabel(keys: LabelKeys, commodity: string, year: number): Label
```

## Namespaces

Every namespace is versioned, like every message type. Changing how a namespace builds
its input, or what its fields mean, needs a new version. The old version stays reserved
and is never reused for a different input.

| Namespace | Input `s` | Used for | Effect of a change |
|---|---|---|---|
| `import/v1` | Either import scheme, pinned in [NORMALIZATION.md](NORMALIZATION.md#the-importv1-label-input) | `import_id` on splits and in `ledger.dismiss` (0023) | Rows already imported post again. |
| `allocation/v1` | `{envelope}\|{month}` | `idem` on materialized allocations (0025) | The current month's allocations post twice. |
| `recon-session/v1` | `{account}` | Data path `data/ledger/recon/session/{label}` (0019) | An in-progress reconciliation is lost. |
| `price/v1` | `{commodity}\|{year}` | Data path of the shared price cache (0027) | The shared cache is refetched. |

The `\|` are table escapes; each is a single `|` (U+007C). In every input:

- `envelope` and `account` are `AccountId`s as is: `acct_` and 20 base64url characters,
  case-sensitive, never folded.
- `month` is a `Month`, `YYYY-MM`, the schedule period being materialized.
- `commodity` is a `Commodity` as is. Its pattern is already uppercase-only, so there is
  nothing to normalize.
- `year` is four decimal digits.

None of these fields can contain `|`, so every input splits back into its fields
unambiguously. `import/v1` contains a free-text description, and NORMALIZATION.md covers
why its field order still keeps inputs distinct.

## Test vectors

These pin the bytes. They were computed independently with Python's `cryptography` HKDF
and with the SDK's own `@noble/hashes`, and the two agreed on every value.

### Keys

| Name | Value |
|---|---|
| `symmetric_root` | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| `space_id` | `SCAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_` (header `0x48`, then public key bytes `0x20`–`0x3f`) |
| `label_key` | `5fb3eda6ed20a93d548cca9ff8410987371b01e78406fb0db033c7fdb97b6df3` |
| `ns_key("import/v1")` | `8ea3bcf9afd938215bd73b4a997a1d7557a00f416af1c91aeda8c8dae5a3d41e` |
| `ns_key("allocation/v1")` | `4f0c34fc41b64a12dfcb96fdca7979e5f958cfff8a3ef0a544694a6cd1e8304d` |
| `ns_key("recon-session/v1")` | `edf04786b2ce89ae92a2dd4eb1aa40a14434d2e0dfa0ccf7688c1e55739f4ce5` |
| `ns_key("price/v1")` | `aff2528ca6505a361e0ecbe78d28861faa28c553eec0d3ecabc1a48f663fa7ed` |

### Labels

The `import/v1` inputs are the label inputs from NORMALIZATION.md's vectors.

| Namespace | `s` | Label |
|---|---|---|
| `import/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|-5\|blue bottle\|#0` | `fHzNwT_vazZtt4ZD4_ds` |
| `import/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|-5\|blue bottle\|#1` | `0DYOhH_pvRLqCs6SE27n` |
| `import/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|12.34\|refund \| acme\|#0` | `gx_aYWRrEd5juPUrfdtc` |
| `import/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|-5\|οδος 5\|#0` | `4008RCU-g26W_5n99gdy` |
| `import/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp\|fitid\|20260914-ABc01` | `zDD51zVCRVeQmz1JmTl_` |
| `import/v1` | (empty) | `T-Yt1sI50YSb1UzDrq8a` |
| `allocation/v1` | `acct_Lm3vT8cHq2NbXr5kYwPd\|2025-12` | `Rbnd0HDlwr8UZRLNe7ES` |
| `recon-session/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp` | `NmrMaf0goLBM2KEhE6wr` |
| `price/v1` | `VTI\|2026` | `Cp6QVP1dMUlu8bhe0WHD` |
| `price/v1` | `acct_7bQ2xV9mKd4TnR1sYgLp` | `OQ4A9jOUebqw-6vnNwGA` |

The Greek row checks that `s` is hashed as UTF-8: `οδος` is `ce bf ce b4 ce bf cf 82`.
The last row isn't a valid `price/v1` input. It is there to show namespace separation: the
same string gives a different label under `recon-session/v1`. A lone surrogate, such as
`"\uD800"`, is an error and has no vector.
