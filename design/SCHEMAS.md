# Message and State Schemas

This is the wire format for everything Absurd Money writes to a space.
Every message posted to a topic is permanent, so once the first message
of a type is posted, its `v: 1` schema can never change. The reasoning
behind the data model is in [ACCOUNTING.md](ACCOUNTING.md); this
document only pins the shapes and the rules for validating them. Issue
[0001](../issues/0001-message-schemas.md) records the decisions made
while writing it.

## Conventions

### Envelope

Each message is a reeeductio message. Its `type` is one of the names
below and is sent **in cleartext**. Its `data` is a UTF-8 JSON object,
encrypted under the topic key. State documents use the same encoding, at
the State path given for each one. Sender, signature, `prev_hash`, and
server timestamp come from the reeeductio envelope
([types.ts](https://github.com/reeeductio/reeeductio/blob/main/typescript-sdk/src/types.ts))
and are never repeated inside `data`.

| Topic | Message types |
|---|---|
| `journal-YYYY` | `ledger.entry`, `ledger.reversal`, `ledger.edit`, `ledger.dismiss`, `ledger.lotadjust` |
| `budget` | `ledger.allocation`, `ledger.reallocation` |
| `recon` | `ledger.recon` |
| `checkpoints` | `ledger.checkpoint` |

### Versioning and strictness

- Every message and every State document has `"v": 1`, an integer.
- **Unknown fields are invalid.** A reader never guesses at a field it
  doesn't understand, because a field it skipped could have changed the
  meaning of the message (the way `replaces` or `from_lots` would).
  Adding a field means bumping `v`.
- **An unknown `v` stops the fold.** A client that meets a version newer
  than it knows must not skip the message, since skipping a ledger fact
  gives wrong balances. It stops folding that topic and asks the user to
  update.
- A State document's history keeps every old revision forever, so
  readers of historical revisions must keep supporting every `v` that
  was ever written.
- JSON objects must not contain duplicate keys. A field that is optional
  and absent is omitted. It is never `null` unless the schema says
  `null` means something.

### Two kinds of validation

- **Post-time checks** are run by the client before posting and may
  depend on anything the client knows: the current chart, today's date,
  the projection. They are listed as *Post-time*.
- **Fold-time rules** decide whether a message counts. Every client must
  reach the same verdict, so they depend only on the message itself,
  other messages, and State facts that can never change (an account's
  `type` and `cur` and an envelope's `cur` are immutable, and accounts
  and envelopes are never deleted). A message that breaks a fold-time
  rule is **ignored by the fold and surfaced** to the user as an
  anomaly. It is never repaired. They are listed as *Fold-time*.

The server can check neither kind, since it sees only ciphertext.

### Primitive types

| Name | Wire form | Rule |
|---|---|---|
| `Int` | JSON string | Signed integer in minor units: `^-?(0\|[1-9][0-9]*)$`. No `-0`, no `+`, no leading zeros, no exponent. Parsed to `BigInt`. |
| `PosInt` | JSON string | As `Int`, but strictly greater than zero: `^[1-9][0-9]*$`. Used for quantities, where zero would be a no-op. |
| `Exp` | JSON number | Integer from 0 to 30. The value is `Int × 10^-exp`. |
| `Commodity` | JSON string | `^[A-Z0-9][A-Z0-9._-]{0,15}$`. ISO 4217 code for currencies (`USD`), ticker for securities (`VTI`), symbol for crypto (`BTC`). |
| `Date` | JSON string | Calendar date `YYYY-MM-DD`, no time zone. |
| `Month` | JSON string | `YYYY-MM`. |
| `MsgId` | JSON string | A reeeductio message ID (its `message_hash`): `^M[A-Za-z0-9_-]{43}$`. |
| `LotId` | JSON string | `{MsgId}#{index}`, where `index` is the split index in decimal with no leading zeros. |
| `AccountId` | JSON string | `acct_` + base64url of 15 random bytes: `^acct_[A-Za-z0-9_-]{20}$`. |
| `PayeeId` | JSON string | `payee_` + 20 characters, as for `AccountId`. |
| `RuleId` | JSON string | `rule_` + 20 characters, as for `AccountId`. |
| `EnvelopeId` | JSON string | `env_` + 20 characters, as for `AccountId`. An envelope is not an account, so no split can name one. |
| `Label` | JSON string | A keyed PRF label ([LABELS.md](LABELS.md), 0005): base64url of 15 bytes, `^[A-Za-z0-9_-]{20}$`. |
| `BlobRef` | JSON object | `{"blob": "B…", "dek": "…"}`. `blob` is a reeeductio blob ID, `^B[A-Za-z0-9_-]{43}$`. `dek` is the 32-byte AES-256 key from `encryptAndUploadBlob`, base64url with no padding (43 characters). |

**Random and PRF identifiers are 15 bytes** (120 bits). The length is a
multiple of 3 bytes, so the base64url encoding is exactly 20 characters
with no padding and no partial final character. Every ID has the same
length, every 20-character string decodes, and each value has exactly
one spelling. (At 16 bytes the last of 22 characters would carry only 2
bits, and a lenient decoder could accept several spellings of one ID.)

The length only has to defeat accidental collisions. Guessing a label is
prevented by the HMAC key, not by its length, and no one gains by
engineering a collision on a random ID: the server can't create IDs, and
a member can already read the real ones. At 120 bits the birthday bound
is negligible. Ten thousand random IDs collide with probability about
10⁻²⁸, and a million import labels about 10⁻²⁵.

An **amount** is always three fields together: `amount` (`Int`), `exp`
(`Exp`), and `cur` (`Commodity`). Amounts are strings so that no JSON
parser ever turns one into a double. Amounts are compared by **value**,
never by spelling: `"8400"` at exp 2 equals `"84"` at exp 0, and every
"equals", "is zero", and "sums to zero" below means value equality. Two
amounts in the same commodity with different exponents are compared and
summed after scaling both to the larger exponent. Decoding, arithmetic,
parsing, and the canonical decimal form are specified in
[AMOUNTS.md](AMOUNTS.md) (0002).

Where an amount is nested as its own object it is written `Amount`,
meaning `{"amount": Int, "exp": Exp, "cur": Commodity}` with exactly
those three fields.

### Routing

Every message in a `journal-YYYY` segment that has a `date` must have a
date in year `YYYY` (*Fold-time*). Messages with no date (`ledger.edit`,
`ledger.dismiss`) follow the routing rule given for that type. A message
posted to a segment after that segment's final close is ignored (see
`ledger.checkpoint`).

---

## Journal segment messages (`journal-YYYY`)

### `ledger.entry`

A balanced journal entry. Lots are created and drawn down by its splits.

```json
{
  "v": 1,
  "date": "2026-09-14",
  "payee": "payee_kR3nQ8vZ1mH7bWxT2yLp",
  "memo": "groceries + household",
  "splits": [
    {"account": "acct_7bQ2xV9mKd4TnR1sYgLp", "amount": "-8423", "exp": 2, "cur": "USD",
     "import_id": "Xk2mP9qR4tV7wY1zA3bC"},
    {"account": "acct_Qd8nY2rMw5TkVb7xHgLp", "amount": "6112", "exp": 2, "cur": "USD"},
    {"account": "acct_9fKwR4tJmQ7vZx2LnBcH", "amount": "2311", "exp": 2, "cur": "USD"}
  ],
  "receipts": [{"blob": "B…", "dek": "…"}],
  "source": {"blob": "B…", "dek": "…"}
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `date` | `Date` | yes | The date of the transaction. Chooses the segment. |
| `splits` | `Split[]` | yes | Two or more. |
| `payee` | `PayeeId` | no | |
| `memo` | string | no | Non-empty. |
| `receipts` | `BlobRef[]` | no | Non-empty. Each blob's DEK travels with the entry, so whoever can read the entry can open exactly its receipts. |
| `source` | `BlobRef` | no | The imported file the entry came from (0023), so the source stays auditable. |
| `replaces` | `MsgId` | no | The entry this one replaces, after that entry was reversed. Used only by the UI to show the reversal and the replacement as one corrected line. |

A **`Split`**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `account` | `AccountId` | yes | |
| `amount` | `Int` | yes | Positive is a debit. Must not be zero. |
| `exp` | `Exp` | yes | |
| `cur` | `Commodity` | yes | |
| `cost` | `Amount` | no | Present only on a **lot-creating** split: the total cost of the lot, never a per-unit price. |
| `acquired` | `Date` | with `cost` | The acquisition date. It may be earlier than the entry date, as for opening lots. |
| `from_lots` | `LotDraw[]` | no | Present only on a **disposal** split: the lots this quantity is drawn from. |
| `import_id` | `Label` | no | The import row (0023) that confirms this split, a label in the `import/v1` namespace. It sits on the split, not the entry, because an import row comes from one account's file and confirms that account's side only. A transfer imported from both files carries one label on each side. |

A **`LotDraw`**:

| Field | Type | Meaning |
|---|---|---|
| `lot` | `LotId` | The lot drawn from. |
| `qty` | `PosInt` | Quantity drawn, in the split's `exp` and `cur`. |
| `acquired` | `Date` | Copied from the lot, so this segment alone supports Form 8949. |
| `basis` | `Amount` | Basis released from this lot, computed by the rule in [ROUNDING.md](ROUNDING.md#basis-released-by-a-disposal) (0003). Copied for the same reason as `acquired`. |

Fold-time rules:

- The splits sum to exactly zero **per commodity**.
- Every `account` exists in the chart, and each split's `cur` equals its
  account's `cur`. An account holds one commodity; a brokerage holds one
  account per position.
- `cost` and `acquired` appear together, only on a split with positive
  `amount` to an `asset` account.
- `from_lots` appears only on a split with negative `amount` to an
  `asset` account. The sum of its `qty` equals the split's quantity
  drawn (`-amount`). A split never has both `cost` and `from_lots`.
- The lot created by a split is `{this entry's hash}#{index}`. Since
  that hash isn't known until the post succeeds, an entry never cites a
  lot it creates, and nothing names a lot before its entry is committed.
- No two splits of an entry carry the same `import_id`.

Lot problems (an unknown lot, an oversold lot, a `basis` that doesn't
match the rounding policy) are anomalies in the lot fold, checked in the
order given in [ROUNDING.md](ROUNDING.md#order-of-lot-events). They
never change the validity of the entry or any balance, because the lot's
creating entry may sit in a segment the reader doesn't hold.

Post-time: no split posts to a closed account; `payee` exists in
`ledger/payees`; no `import_id` is already consumed; the date's segment
is open; `replaces`, if set, names an entry that has been reversed and
that no other entry already replaces.

### `ledger.reversal`

Cancels an earlier entry by posting its inverse.

```json
{
  "v": 1,
  "date": "2026-09-14",
  "reverses": "M…",
  "splits": [
    {"account": "acct_7bQ2xV9mKd4TnR1sYgLp", "amount": "8423", "exp": 2, "cur": "USD"},
    {"account": "acct_Qd8nY2rMw5TkVb7xHgLp", "amount": "-6112", "exp": 2, "cur": "USD"},
    {"account": "acct_Hx7nQ2rMw5TkVb7yGgLp", "amount": "-2311", "exp": 2, "cur": "USD"}
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `date` | `Date` | yes | Chooses the segment, like an entry's date. |
| `reverses` | `MsgId` | yes | The `ledger.entry` being reversed. May be in another segment. |
| `splits` | `Split[]` | yes | The inverse of the target's splits, in the same order, with the **effective** accounts (after edits). No `cost` or `from_lots`. |
| `memo` | string | no | Non-empty. |

The splits are written out rather than derived so that the reversal is
readable from its own segment alone, which matters when it reverses an
entry in a frozen year.

**Date and routing.** The client defaults `date` to the target's date
when the target is unlocked and its segment is open, so the reversal
lands in the same segment and the same period and the register nets the
pair to nothing. Otherwise it defaults to today, like an accountant's
reversing entry in the open period. Either way the segment follows from
the date.

Fold-time rules:

- As for `ledger.entry`: splits sum to zero per commodity, accounts
  exist, `cur` matches.
- A reversal always folds into balances as the balanced entry it is. The
  check that its splits equal the inverse of the target's effective
  splits is an anomaly check, not a validity rule, since the target may
  be in a segment the reader doesn't hold.
- Lots: if the target created lots, those lots are void (no remaining
  quantity, no basis). If the target drew from lots, those draws are
  void.
- A target reversed more than once is an anomaly. Every reversal still
  folds.

Post-time: the target is a `ledger.entry` and is not already reversed;
the splits are the inverse of its effective splits; the date's segment
is open.

There is no `ledger.replacement` type. A replacement is a `ledger.entry`
with `replaces` set to the original entry's hash.

### `ledger.edit`

An overlay on earlier entries, for fields that don't change any amount.

```json
{
  "v": 1,
  "edits": [
    {"target": "M…", "memo": "Thanksgiving groceries"},
    {"target": "M…", "splits": {"2": "acct_Hx7nQ2rMw5TkVb7yGgLp"}},
    {"target": "M…", "payee": null, "receipts": []},
    {"target": "M…", "import_ids": {"1": "Pq7rS0tU3vW6xY9zA2bC"}}
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `edits` | `Edit[]` | yes | Non-empty. Several edits may name the same target. |

An **`Edit`** has a `target` and at least one other field:

| Field | Type | Meaning |
|---|---|---|
| `target` | `MsgId` | A `ledger.entry` in the **same segment** as this edit. Never another edit. |
| `memo` | string or `null` | Replaces the memo. `null` clears it. |
| `payee` | `PayeeId` or `null` | Replaces the payee. `null` clears it. |
| `receipts` | `BlobRef[]` | **Replaces** the receipt list. `[]` clears it. |
| `splits` | object | Maps a split index (decimal string, `"0"`, `"2"`) to a new `AccountId`. Only the named splits change. |
| `import_ids` | object | Maps a split index to a `Label`, setting that split's `import_id`. This records an **import match**: a new row recognized as a split already in the journal (see "Import consumption and matching"). |

**Semantics.** A field's effective value is what the latest valid edit
naming it says, in chain order. For `splits` and `import_ids`, each
index is its own field. Receipts are replaced, not appended, so the
latest edit is the whole answer and removing a receipt needs no special
case.

Fold-time rules, applied **to each edit separately**:

- The target is a `ledger.entry` earlier in this segment's chain. An
  edit naming a target in another segment is ignored.
- A split edit is valid only if the old and new accounts are both
  `income` or `expense` accounts, and the new account's `cur` equals the
  split's `cur`. Here the old account is the one effective just before
  this edit.
- A split edit is invalid if the target is **locked**: some
  `ledger.checkpoint` cites a head in this segment that is at or after
  the target and before this edit.
- A split edit is invalid if the target has been reversed by a reversal
  earlier in this segment's chain. (A reversal in a later segment can
  only exist once this segment is frozen, and then no more edits can be
  posted.)
- An `import_ids` edit is valid only if the split has no effective
  `import_id` yet. A label, once set, is never replaced, so a consumed
  row can't become unconsumed.
- `memo`, `payee`, `receipts`, and `import_ids` edits are valid on
  locked and reversed entries, since none of them changes a balance.

A malformed message (a bad shape or type) is rejected whole. An edit
that fails a semantic rule is ignored on its own, and the rest of the
message still applies. The client keeps each message under the server's
100 KB limit by splitting large batches.

Post-time: each edit passes the fold-time rules against its target's
effective fields; the target is not reversed in any segment if the edit
moves a split; no split moves to a closed account; `payee`, if set,
exists in `ledger/payees`; no label in `import_ids` is already
consumed; the target's segment is open.

### `ledger.dismiss`

Marks import rows as handled without posting an entry.

```json
{"v": 1, "import_ids": ["Xk2mP9qR4tV7wY1zA3bC"]}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `import_ids` | `Label[]` | yes | Non-empty, no duplicates. |

**Routing.** To the segment of the year of the import rows' dates. All
`import_ids` in one message must share a year.

A dismissal is for rows that should be ignored, such as a pending charge
that never posted, and for matches that can't be recorded as an edit
because the matched split's segment is frozen.

Post-time: no label is already consumed; the segment is open. A client
packs dismissals by year and keeps each message under the size limit.

### Import consumption and matching

A row is **consumed** if and only if its label is the effective
`import_id` of some split (set at posting or by an edit) or appears in a
dismissal. A dismissal can't be undone, but it doesn't need to be:
posting an entry that carries the same label is still valid.

A split on an account that has an import profile is **confirmed** if it
has an effective `import_id`, and **unconfirmed** otherwise. Unconfirmed
splits are the candidates for matching. When the review step sees a new
row, it looks in the same account for an unconfirmed split with the same
amount and a nearby date. That one query covers both ways a row can
already be in the journal:

- the other side of a transfer, posted when the first account's file was
  imported, and
- a transaction entered by hand before it showed up in an export.

Accepting a match posts a `ledger.edit` setting the split's `import_id`,
routed to the target's segment like any edit. That segment is open until
its final close, so a December transfer that clears in January is still
matched by an edit. If the segment is frozen, the row is dismissed
instead. The heuristics (date window, whether descriptions count) live
in the client, not the schema, so they can improve without changing
anything already posted.

A label that becomes the `import_id` of two splits, or of a split and a
dismissal, is an anomaly.

### `ledger.lotadjust`

Changes lot quantities with no money moving, for stock splits.

```json
{
  "v": 1,
  "date": "2026-06-10",
  "adjustments": [
    {"lot": "M…#0", "account": "acct_…", "exp": 0, "cur": "VTI",
     "old_qty": "100", "new_qty": "200"}
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `date` | `Date` | yes | The effective date of the split. Chooses the segment. |
| `adjustments` | `LotAdjustment[]` | yes | Non-empty. One message covers every lot affected by one corporate action. |
| `memo` | string | no | Non-empty. |

A **`LotAdjustment`**:

| Field | Type | Meaning |
|---|---|---|
| `lot` | `LotId` | |
| `account` | `AccountId` | The lot's account, copied so this segment can apply the change to the account's balance on its own. |
| `exp` | `Exp` | Exponent of both quantities. |
| `cur` | `Commodity` | Must equal the account's `cur`. |
| `old_qty` | `PosInt` | The lot's remaining quantity immediately before the adjustment. |
| `new_qty` | `PosInt` | The remaining quantity after it. |

Semantics:

- The account's balance changes by `new_qty − old_qty`. This is exempt
  from sum-to-zero, so the commodity's trading account keeps its
  pre-split quantity. That residual is harmless and is not an anomaly.
- The lot's remaining quantity becomes `new_qty`. Its basis and
  acquisition date don't change.
- Disposals citing the lot that are **dated on or after** `date` are in
  post-adjustment units. Disposals dated before it are in pre-adjustment
  units. Ordering by date, not by chain, keeps this well-defined across
  segments.
- If `old_qty` doesn't match the lot's remaining quantity as folded at
  `date`, that's a lot anomaly.

---

## Other topics

### `ledger.allocation` (topic `budget`)

Assigns money to an envelope, or takes it away, changing To Be Budgeted.
A move between envelopes is one `ledger.reallocation`, not two
allocations.

```json
{"v": 1, "date": "2025-12-01", "envelope": "env_Lm3vT8cHq2NbXr5kYwPd",
 "amount": "70000", "exp": 2, "cur": "USD", "idem": "Qp4rS7tU0vW3xY6zA9bC"}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `date` | `Date` | yes | |
| `envelope` | `EnvelopeId` | yes | An envelope in `ledger/budget`. |
| `amount`, `exp`, `cur` | amount | yes | Non-zero. Negative takes money out of the envelope. `cur` equals the envelope's `cur`. |
| `idem` | `Label` | no | Present only on allocations materialized from the schedule: `label("allocation/v1", "{envelope}\|{YYYY-MM}")`. |
| `memo` | string | no | Non-empty. |

Fold-time rules: `envelope` exists and `cur` equals its `cur`.
Allocations are exempt from sum-to-zero. If two allocations carry the
same `idem`, only the first in the `budget` chain counts; the others are
duplicates from a materialization race and are ignored.

Post-time: the envelope is open.

### `ledger.reallocation` (topic `budget`)

Moves money between envelopes in one message, so a move is never left
half done. To Be Budgeted is unchanged.

```json
{"v": 1, "date": "2026-10-14", "cur": "USD", "memo": "cover groceries overspend",
 "legs": [
   {"envelope": "env_Hx7nQ2rMw5TkVb7yGgLp", "amount": "-2000", "exp": 2},
   {"envelope": "env_Lm3vT8cHq2NbXr5kYwPd", "amount": "2000", "exp": 2}
 ]}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `date` | `Date` | yes | |
| `cur` | `Commodity` | yes | The commodity of every leg. A move never crosses commodities, which would need an exchange rate. |
| `legs` | `Leg[]` | yes | Two or more, each naming a different envelope. |
| `memo` | string | no | Non-empty. |

A **`Leg`**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `envelope` | `EnvelopeId` | yes | An envelope in `ledger/budget`. |
| `amount` | `Int` | yes | Non-zero. Negative takes money out of the envelope. |
| `exp` | `Exp` | yes | |

Fold-time rules:

- Every leg's `envelope` exists, and its `cur` equals the message's
  `cur`.
- The legs sum to exactly zero.

A reallocation that breaks either rule is ignored whole; no leg counts.
Each leg that counts adds to its envelope as an allocation would. A
reallocation carries no `idem`, since only scheduled allocations are
materialized.

Post-time: no leg names a closed envelope.

### `ledger.recon` (topic `recon`)

A completed statement reconciliation.

```json
{
  "v": 1,
  "account": "acct_7bQ2xV9mKd4TnR1sYgLp",
  "statement_date": "2026-09-30",
  "closing_balance": {"amount": "412377", "exp": 2, "cur": "USD"},
  "cleared": ["M…", "M…"],
  "statement": {"blob": "B…", "dek": "…"}
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `account` | `AccountId` | yes | An `asset` or `liability` account. |
| `statement_date` | `Date` | yes | |
| `closing_balance` | `Amount` | yes | The statement's closing balance, signed as balances are, positive for a debit: a card statement showing 500.00 owed is `"-50000"`. `cur` equals the account's `cur`. |
| `cleared` | `MsgId[]` | yes | The entries and reversals this statement clears, for this account. May be empty and may span two segments. No duplicates. |
| `statement` | `BlobRef` | no | The statement file. |
| `supersedes` | `MsgId` | no | An earlier `ledger.recon` for the same account that this one replaces. The superseded message's `cleared` set no longer counts. This is how a mistaken reconciliation is fixed. |

An entry is cleared **for an account** if and only if its hash is in the
`cleared` set of some recon for that account that has not been
superseded. Clearing applies to all of the entry's splits on that
account.

Fold-time rules:

- `account` exists and is an `asset` or `liability` account, and
  `closing_balance.cur` equals its `cur`.
- `supersedes`, when present, names an earlier recon in the chain that
  counts, for the same `account`.

A recon that breaks a rule is ignored and doesn't supersede anything.
Whether a `cleared` hash names a transaction on the account is not a
fold-time rule, since the journal may not be synced yet: a hash that
names none clears nothing. Two recons that are not superseded and clear
the same transaction for the same account both count, and the later one
is surfaced as `cleared-twice` (two devices reconciling at once).

Post-time: every `cleared` hash is an entry or reversal with a split on
the account, and none is already cleared by a recon that will still
stand; `supersedes` names a recon that has not been superseded;
`statement_date` is after the latest recon of the account that will
still stand; and the account's cleared balance, the sum of the splits on
it in every transaction cleared by a recon that will still stand, this
one included, equals `closing_balance`.

### `ledger.checkpoint` (topic `checkpoints`)

One type covers both a **period close** (heads only) and a **full
checkpoint** (heads plus balances).

```json
{
  "v": 1,
  "period": "2025-12",
  "rounding": "v1",
  "heads": [
    {"topic": "journal-2025", "hash": "M…", "final": true}
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | |
| `period` | string | yes | Display label: `YYYY`, `YYYY-MM`, or `YYYY-Qn`. Locking is positional, so this only names the close. |
| `rounding` | string | yes | The rounding policy used to compute everything in this message. `"v1"`, which names [ROUNDING.md](ROUNDING.md) (0003). Every `v: 1` figure is a sum or a copy, so none depends on it yet. Required even on a bare close, so every checkpoint says how it was computed. |
| `heads` | `Head[]` | yes | Non-empty, at most one per topic. |
| `balances` | `Balance[]` | no | Full checkpoint: the balance of every account and commodity. |
| `envelopes` | `EnvelopeBalance[]` | no | Full checkpoint: every envelope's available balance. |
| `lots` | `OpenLot[]` | no | Full checkpoint: every lot with remaining quantity. |
| `prices` | `Price[]` | no | Full checkpoint: the prices used for any valuation. |

A **`Head`** is `{"topic": string, "hash": MsgId, "final"?: true}`.
`topic` is a journal segment (`journal-YYYY`) or `budget`. `final` may
appear only on a journal segment.

**What a close cites.** A close cites only the segments it means to
lock, at their heads when it is posted. Closing December 2025 in January
cites `journal-2025` alone, which leaves January's 2026 entries
unlocked. A **full checkpoint** cites every journal segment that exists,
including frozen ones, plus `budget`, since its balances fold over all
of them. `balances`, `envelopes`, `lots`, and `prices` appear only on a
full checkpoint, and `balances` is required on one.

Semantics:

- **Lock.** An entry in segment `S` is locked if some checkpoint cites a
  head in `S` at or after the entry. Locking forbids split-account edits
  (see `ledger.edit`).
- **Freeze.** `final: true` freezes the segment. Any message in that
  segment after the cited head is ignored by the fold and surfaced. The
  client refuses to post to a frozen segment.
- A checkpoint is a claim about a fold. Who may sign one, and how a
  reader verifies it, is the checkpoint trust model (an open question in
  ACCOUNTING.md). A client holding the full history recomputes the claim
  and reports any mismatch.

Post-time, for a period close: no `balances`, `envelopes`, `lots`, or
`prices`; every head is a journal segment that is listed in
`ledger/journal`, is still open, and is no later than the year of
`period`; and a head with `final` belongs to a close whose `period` is
that segment's whole year (`YYYY`). The client cites each segment's head
as the server reports it when posting.

| Type | Fields |
|---|---|
| `Balance` | `account`, `amount`, `exp`, `cur` |
| `EnvelopeBalance` | `envelope` (`EnvelopeId`), `amount`, `exp`, `cur` |
| `OpenLot` | `lot`, `account`, `qty` (`PosInt`), `exp`, `cur`, `basis` (`Amount`, remaining basis), `acquired` |
| `Price` | `commodity`, `date`, `price` (`Amount`, the price of one whole unit of `commodity`) |

---

## State documents

Each document is one State path, read with one point read and rewritten
whole. All of them carry `v` and `rev`. `rev` starts at 1 and goes up by
one on every write. The reeeductio state chain provides CAS; `rev` is
there so a person reading history can tell revisions apart.

### `ledger/accounts`

The chart of accounts.

```json
{
  "v": 1,
  "rev": 41,
  "accounts": {
    "acct_7bQ2xV9mKd4TnR1sYgLp": {"name": "Checking", "type": "asset", "cur": "USD",
                                    "parent": null},
    "acct_Qd8nY2rMw5TkVb7xHgLp": {"name": "Groceries", "type": "expense", "cur": "USD",
                                    "parent": null},
    "acct_Zj4mH8qLv2NxRt6kYwPd": {"name": "Visa 4421", "type": "liability", "cur": "USD",
                                    "parent": null, "closed_at": "2024-03-02"}
  }
}
```

An **`Account`**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Non-empty. May change. |
| `type` | string | yes | `asset`, `liability`, `equity`, `income`, or `expense`. **Immutable.** |
| `cur` | `Commodity` | yes | The one commodity the account holds. **Immutable.** |
| `parent` | `AccountId` or `null` | yes | Must have the same `type`. No cycles. |
| `closed_at` | `Date` | no | Closed accounts stay in the chart forever. |

The chart holds no budgeting fields. Envelopes, which expense accounts
spend from them, and which accounts are budgetable are all in
`ledger/budget`.

Rules:

- Accounts are never removed from the document; they are closed. An ID
  is never reused.
- `type` and `cur` never change once written, because fold-time rules
  depend on them.

### `ledger/journal`

The years that have a `journal-YYYY` segment. The server has no route
that lists topics, and an entry may be dated in any year, so this is how
a client finds every segment (0011).

```json
{
  "v": 1,
  "rev": 3,
  "years": [2024, 2025, 2026]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `years` | number[] | yes | Integers from 0 to 9999, strictly ascending. |

Rules:

- **A year is listed before anything is posted to its segment.** A
  client adds the year, then posts. If the post fails, the year is
  listed with an empty or missing segment, which reads as no messages.
  Posting first could leave a segment that no client knows to read.
- Years are never removed, even from a segment that turned out empty.

A segment posted by a client that skipped the first rule is invisible to
every other client, so the rule is not optional. The list leaks nothing
new, since topic IDs are already cleartext to the server. It is written
about once per year, so its write volume doesn't scale with transaction
count.

### `ledger/budget`

Everything about envelope budgeting that is configuration rather than
history: the envelopes, which expense accounts spend from each, which
accounts count toward To Be Budgeted, and the monthly schedule the
client materializes allocations from. Allocations themselves are events
on the `budget` topic.

```json
{
  "v": 1,
  "rev": 7,
  "envelopes": {
    "env_Lm3vT8cHq2NbXr5kYwPd": {
      "name": "Groceries", "cur": "USD",
      "schedule": [
        {"from": "2024-01", "amount": "60000", "exp": 2},
        {"from": "2025-12", "amount": "70000", "exp": 2}
      ]
    },
    "env_Hx7nQ2rMw5TkVb7yGgLp": {"name": "Dining", "cur": "USD"}
  },
  "spent_from": {
    "acct_Qd8nY2rMw5TkVb7xHgLp": "env_Lm3vT8cHq2NbXr5kYwPd",
    "acct_Tp2wK9sNc4XbVm7rJhQd": "env_Lm3vT8cHq2NbXr5kYwPd",
    "acct_9fKwR4tJmQ7vZx2LnBcH": "env_Hx7nQ2rMw5TkVb7yGgLp"
  },
  "budgetable": ["acct_7bQ2xV9mKd4TnR1sYgLp", "acct_Zj4mH8qLv2NxRt6kYwPd"]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `envelopes` | object | yes | `EnvelopeId` to `Envelope`. May be empty. |
| `spent_from` | object | yes | An expense `AccountId` to the `EnvelopeId` it is spent from. May be empty. |
| `budgetable` | `AccountId[]` | yes | Asset and liability accounts that count toward To Be Budgeted. No repeats. May be empty. |

An **`Envelope`**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Non-empty. May change. |
| `cur` | `Commodity` | yes | **Immutable.** |
| `closed_at` | `Date` | no | Closed envelopes stay in the document forever. |
| `schedule` | `Step[]` | no | Non-empty, sorted by `from` with no repeats. |

A **`Step`** is `{"from": Month, "amount": Int, "exp": Exp}`, in the
envelope's `cur`. It sets the monthly allocation from that month until
the next step. `amount` may be `"0"` to stop allocating.

Rules:

- Envelopes are never removed; they are closed. An ID is never reused.
  `cur` never changes once written, because fold-time rules depend on
  it.
- **`spent_from` points from the expense to the envelope.** That makes
  it a function: each expense account is spent from at most one
  envelope, while one envelope may fund several expense accounts (above,
  Groceries funds two). Pointing the other way would let two envelopes
  claim the same expense, and its spending would count twice. An expense
  account with no entry is spent from no envelope.
- **Pairing is timeless**, like accounts. Changing an account's
  `spent_from` moves all of its spending, past and future, to the new
  envelope, and removing it returns that spending to no envelope. The
  sum of envelope balances, and so To Be Budgeted, changes only when an
  account gains or loses an envelope, not when it moves between two. To
  change where spending goes from a date on, split the expense account
  instead: close the old one and pair a new one.
- **`budgetable` may include liabilities**, so credit cards can be
  budgeted. Otherwise a card purchase would lower an envelope without
  lowering any budgetable asset, and To Be Budgeted would go up. With
  the card counted,

  ```text
  To Be Budgeted = Σ budgetable asset and liability balances − Σ envelope balances
  ```

  and spending on the card leaves it unchanged.

The document refers to accounts in `ledger/accounts`, which is written
separately. Accounts are never removed and their `type` and `cur` never
change, so a reference that was valid when written stays valid.

Post-time, checked against the current chart:

- Each `spent_from` key is an `expense` account, and its envelope
  exists, is open, and has the same `cur`.
- Each `budgetable` account is an `asset` or `liability` account.
- No envelope is removed, and no envelope's `cur` changes.

Fold-time: a `spent_from` pairing whose account is not an expense
account, or whose envelope is missing or in another commodity, is
ignored and surfaced, as is a `budgetable` entry that is not an asset or
liability account.

### `ledger/payees`

```json
{
  "v": 1,
  "rev": 12,
  "payees": {
    "payee_kR3nQ8vZ1mH7bWxT2yLp": {"name": "Blue Bottle Coffee"},
    "payee_W2xY5zA8bC1dE4fG7hJ0": {"name": "Blue Bottle", "merged_into": "payee_kR3nQ8vZ1mH7bWxT2yLp"}
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Non-empty. |
| `merged_into` | `PayeeId` | no | This payee is a duplicate of another. Entries keep the old ID, and the UI resolves it. No chains: the target must not itself be merged. |

Payees are never removed, since entries cite them forever.

A client matches a typed name against `name` after the `import/v1`
normalization ([NORMALIZATION.md](NORMALIZATION.md)), resolving a merged
payee to its target, and adds a payee only when no name matches. Two
devices adding the same name at once can still leave two payees with it;
that is fixed by merging, and until then the match picks a payee not
merged away over a merged one, then the lowest ID.

Post-time: `rev` goes up by one, no payee is removed, and no merge
chains.

### `ledger/rules`

Import rules, read in bulk at review time. Issue
[0021](../issues/0021-categorization-rules.md).

```json
{
  "v": 1,
  "rev": 3,
  "rules": [
    {"id": "rule_…", "op": "contains", "pattern": "blue bottle",
     "payee": "payee_kR3nQ8vZ1mH7bWxT2yLp", "account": "acct_…"},
    {"id": "rule_…", "op": "prefix", "pattern": "zelle from", "sign": "positive",
     "scope": "acct_7bQ2xV9mKd4TnR1sYgLp", "account": "acct_…"}
  ]
}
```

`rules` is an ordered list. A **`Rule`**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `RuleId` | yes | Unique within the document. |
| `op` | string | yes | `contains`, `prefix`, or `equals`. |
| `pattern` | string | yes | Non-empty. Compared against `field` after `import/v1` normalization ([NORMALIZATION.md](NORMALIZATION.md)), and is itself stored normalized. |
| `field` | string | no | `"description"` (the default when absent) or `"memo"`: the profile column the pattern is compared against. A row with no memo matches no `memo` rule. |
| `sign` | string | no | `"positive"` or `"negative"`: matches only rows whose amount, as posted to the account, has that sign. Negative is money out of an asset or a charge on a liability. |
| `scope` | `AccountId` | no | Applies only to rows imported into this account. |
| `payee` | `PayeeId` | no | |
| `account` | `AccountId` | no | The category for the other side of the entry. |

A rule must set at least one of `payee` and `account`.

Rules only suggest. They choose a payee and a category for each row in
review, and nothing is posted until the user approves. Every client must
choose the same way:

- A rule **matches** a row when its `scope` (if any) is the account
  being imported into, its `sign` (if any) is the amount's, and its
  `op` holds between the normalized `field` text and `pattern`.
- **The payee and the category are chosen separately.** Each comes from
  the first matching rule, in order, that sets a usable one. A rule that
  sets only a payee doesn't stop a later rule from choosing the
  category.
- A `payee` is usable if it exists, and resolves through its merge. An
  `account` is usable if it exists, is open, holds the same commodity as
  the account being imported into, and is not that account. A rule whose
  reference isn't usable is passed over for that field, not for the
  other.

Post-time, checked against the current chart and payee list, for each
rule that is new or changed (an unchanged rule isn't checked again, so
closing its account doesn't block later writes):

- `scope` is an `asset` or `liability` account.
- `account` exists and is open, is not `scope`, and has `scope`'s `cur`.
- `payee` exists and is not merged away.

`rev` goes up by one. Rules may be removed and reordered, since nothing
cites a `RuleId`.

### `ledger/import-profiles`

CSV mapping profiles, keyed by the account the file is imported into.

```json
{
  "v": 1,
  "rev": 2,
  "profiles": {
    "acct_7bQ2xV9mKd4TnR1sYgLp": {
      "delimiter": ",",
      "skip_rows": 0,
      "header": true,
      "date": {"column": "Posting Date", "format": "MM/DD/YYYY"},
      "amount": {"column": "Amount", "negate": false},
      "description": {"column": "Description"},
      "exp": 2
    }
  }
}
```

A **`Profile`**:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `delimiter` | string | yes | One character, not `"`, CR, or LF. |
| `decimal` | string | no | `"."` (the default when absent) or `","`. The decimal separator in the amount column, for the parser in [AMOUNTS.md](AMOUNTS.md#parsing-text). |
| `encoding` | string | no | The file's encoding, a WHATWG Encoding Standard canonical name: `"utf-8"` (the default when absent), `"utf-16le"`, `"utf-16be"`, or `"windows-1252"`. Never guessed at import time. See "Reading a file". |
| `skip_rows` | number | yes | Physical lines to skip before the header or first row. |
| `skip_end_rows` | number | no | Physical lines to skip at the end of the file, such as a totals line. Default 0. Trailing empty lines aren't counted. |
| `header` | boolean | yes | Whether the first row after `skip_rows` names the columns. |
| `date` | `{column, format}` | yes | `format` is built from `YYYY`, `YY`, `MM`, `DD`, `M`, `D` and literal separators, with exactly one year, month, and day. `YY` is 20YY. `M` and `D` take one or two digits. A cell with anything else, such as a time of day, is an error. |
| `amount` | `{column, negate}` or `{debit, credit}` | yes | One signed column, with `negate: true` when the export shows charges as positive; or separate debit and credit columns, where `debit` lowers the amount posted to the account. |
| `description` | `{column}` | yes | The text hashed into the row scheme's `import/v1` label ([NORMALIZATION.md](NORMALIZATION.md)). Map it to whichever column best identifies the transaction. |
| `memo` | `{column}` | no | A second text column, shown in review and available to import rules. Not part of the label: banks rewrite memo text between pending and posted. |
| `fitid` | `{column}` | no | When present, the import ID uses the fitid scheme (0023). |
| `pending` | `{column, value}` | no | Rows whose `column` equals `value` are skipped as pending. |
| `exp` | `Exp` | yes | Exponent the file's amounts are parsed at. A cell with more non-zero fractional digits is an error, never rounded. The commodity is the account's `cur`. |

A `column` is a header name (string) when `header` is true, and a
0-based index (number) otherwise.

Post-time, checked against the current chart: `rev` goes up by one; no
profile is removed; a profile never changes its import ID scheme
(gaining or losing `fitid`), since one account's labels never mix the
two (0023); and every new or changed profile is keyed by an open
`asset` or `liability` account. An unchanged profile isn't checked
again. Other changes are allowed, but some change the labels of rows
already imported (the description, date, or amount columns, the sign,
or the encoding), so the next import of an overlapping file shows those
rows again. The client warns before saving such a change.

#### Reading a file

Decoding and CSV parsing feed the `import/v1` label, so both are pinned.
The rest is client behavior, but every client must agree on which rows
are imported. Issue 0020.

1. **Decode** the bytes with `encoding` and `TextDecoder`'s `fatal:
   true`. A file that isn't valid in that encoding fails, instead of
   minting labels from U+FFFD. `windows-1252` accepts every byte, so a
   file that is valid UTF-8 with non-ASCII bytes also fails under
   `windows-1252`. A leading BOM is removed only when it matches the
   encoding.
2. **Skip** `skip_rows` physical lines from the start and
   `skip_end_rows` from the end. CRLF, LF, and a lone CR each end a
   line. Skipping happens before parsing, so a preamble or trailer needn't
   be valid CSV.
3. **Parse** with the grammar in "CSV grammar" in
   [NORMALIZATION.md](NORMALIZATION.md).
4. **Map** each record. With `header`, the first record names the
   columns. Header cells are matched after trimming whitespace. A
   column the profile uses that is missing, or that appears twice, fails
   the import, and so does a row too short to contain one.

Each row then has exactly one outcome, checked in this order:

| Condition | Outcome |
|---|---|
| `pending` matches: the trimmed cell equals `value` exactly | Skipped as pending. |
| Blank amount: the cell is empty or whitespace. With debit/credit, both cells are. | Skipped and reported. These are balance rows or continuations, never transactions. |
| Debit and credit both non-empty, where a cell that parses to zero counts as empty | The import fails. |
| The amount is zero | Skipped and reported. A split can't be zero. |
| The amount or date doesn't parse | The import fails, citing the line. A trailer belongs in `skip_end_rows`. |
| `fitid` profile, and the `fitid` cell is empty after `normalizeFitid` | Flagged for manual entry and never imported. It can't fall back to the row scheme (0023). |
| `fitid` profile, and the `fitid` repeats an earlier row's in the same file | The import fails. |
| Otherwise | Imported. |

The amount is the cell parsed with `parseDecimal` at `exp`, then
negated when `negate` is set. With debit/credit, the sign written in
either cell is ignored: the amount is credit minus debit. The result is
the signed amount as posted to the account, which goes into the label's
canonical form.
