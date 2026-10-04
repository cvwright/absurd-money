# Double-Entry Personal Finance on reeeductio

## Overview

Can reeeductio back a double-entry personal finance app — accounts, transactions,
balances, budgets, investments, reports, bank imports, shared household books?

Short answer: **yes, and the structural fit is unusually good.** A double-entry
ledger is *already* an append-only log of immutable, balanced journal entries, with every
balance a derived fold over that log. That is reeeductio's topic primitive, almost
verbatim. Accounting wants exactly what reeeductio enforces: never mutate a posted
entry, and prove the log wasn't edited.

The differentiator is a **cryptographically tamper-evident personal ledger**: every
journal entry signed by whoever posted it, hash-chained to its predecessor, with
capability-scoped sharing to a spouse, a bookkeeper, or an accountant at tax time.
Neither Quicken nor YNAB nor Actual can say that, and for a shared or
professionally-reviewed book it is a real property, not a gimmick.

The one genuinely hard problem is **reporting**: the server stores ciphertext and
evaluates no queries. "What's my
balance?" and "show me Q3 dining spend" are aggregations the server cannot compute.
This note works through how to make those cheap anyway.

---

## Why the fit is unusually good

Four properties of double-entry bookkeeping that normally make it awkward to store are
the exact properties reeeductio imposes on you:

| Accounting rule | reeeductio behavior |
|---|---|
| A posted entry is never altered; mistakes are fixed with a reversing entry | Topics are append-only; there is no edit or delete of a message |
| The journal has a definite order; the books close in sequence | Per-topic hash chain with compare-and-swap on the head ([`sql_message_store.py:157`](https://github.com/reeeductio/reeeductio/blob/main/backend/sql_message_store.py#L157)) |
| Every entry has an identified author, for audit | Every message carries an Ed25519 signature over its content and a `sender` |
| Balances are derived, never authoritative | Nothing in the store is a mutable aggregate; everything is a fold |

The usual complaint about event-sourcing a ledger — "now I have to maintain projections"
— is unavoidable here regardless, because the server can't aggregate ciphertext. So the
cost was already paid. You may as well take the integrity guarantees that come with it.

---

## Primitive mapping

| Accounting concept | reeeductio primitive | Notes |
|---|---|---|
| **Journal entry** (a balanced transaction, N≥2 splits) | **Message** in a `journal` topic | Immutable, signed, chained. `message_hash` *is* the transaction ID — content-addressed, so a duplicate post is detectable. |
| **Chart of accounts** — all five types in one place: asset, liability, equity, income, expense | **State** — one document at `ledger/accounts` | The whole chart in a single entry. One point read to load, one write per change, full audit history of every chart revision. See "The chart of accounts is one document". |
| **Balances, registers, budget-vs-actual** | Derived — **not stored** | Client-side projection. See "The reporting problem". |
| **Balance checkpoints / closed periods** | **Message** in a `checkpoints` topic, or a **blob** if large | Signed snapshot anchored to a `journal` chain hash. Makes cold start O(recent) instead of O(all-time). |
| **Completed statement reconciliation** | **Message** in a `recon` topic | Per-transaction cleared status is *derived* from these, not stored per transaction. O(statements) writes, not O(transactions). |
| **In-progress reconciliation session; sync cursors, watermarks** | **Data** at one known path | Losable per-device scratch. Not durable record — no CAS, no history, no enumeration. |
| **Edits** — recategorization, memo, payee, receipts | **Message** (`ledger.edit`) in `journal` | Matrix-style overlay: latest edit per field wins at fold time. Never in State. See "Edits and recategorization". |
| **Period close** | **Message** in `checkpoints` | Cites a `journal` position; entries at or before it are locked against financial edits. |
| **Envelope allocation** ("on 2025-12-01, 700 was assigned to Groceries") and **reallocation** ("on the 14th, 50 moved from Dining to Groceries") | **Message** in a `budget` topic | Immutable, dated, authored. The *facts* the envelope fold reads. ~240 messages/year for 20 envelopes, plus moves. |
| **Budget configuration** — envelopes, which expense accounts spend from each, budgetable accounts, and the schedule ("Groceries gets 600/month from 2024-01") | **State** — one document at `ledger/budget` | Declarative intent, not history. Edited a few times a year; the client materializes allocation events from the schedule. See "Envelope budgeting". |
| **Tax lots** (quantity, cost basis, acquisition date) | **Message** in `journal` — the entry that created them | Identified `{message_hash}#{split_index}`. Remaining quantity is *derived* by folding disposals, never stored. |
| **Market prices / quotes** | **Not in the space** — local cache, optionally **Data** per `(commodity, year)` | Externally sourced, non-authoritative, re-fetchable. Checkpoints carry the prices they used. |
| **Receipts, statements, imported OFX/CSV files** | **Blob** (content-addressed, E2E-encrypted) | Dedup for free; same statement imported twice is one object. |
| **Bank/institution sync connection** (future, if ever) | **Tool account** with create-only capability | No ambient authority; see "Ingest". |
| **Payees, tags, import rules** | **State** — one document each, `ledger/payees` and `ledger/rules` | Payees get random IDs like accounts. Import rules map raw merchant strings to payees, so matching can improve without changing any ID. |
| **UI cursors, "last sync at", projection watermarks** | **Data** (signed, no history) | Per-device scratch; history would be noise. |
| **Spouse / bookkeeper / accountant access** | **Roles + capabilities** | Path-scoped. See "Shared books". |

### Topic layout, and why it's more than one topic

Chain heads are scoped per `(space_id, topic_id)`, so **each topic is an independent
concurrency domain**. That makes topic choice a concurrency decision, not just naming:

- `journal` — the postings. The hot append path. Physically this is one topic per year,
  `journal-2026` etc. (see "One ledger, yearly segments"); elsewhere in this note
  "`journal`" means the set of segments.
- `checkpoints` — periodic signed balance snapshots. Written rarely, by one writer.
- `import-staging` — reserved for a future bank-sync tool account, which may never be
  built. Client-side CSV import does not use it. See "Ingest".
- `recon` — completed statement reconciliations. See "Reconciliation is an event, not a
  flag".
- `budget` — envelope allocations. See "Envelope budgeting".

Critically, **all State writes share a single chain**: `set_state` is implemented as a
post to one reserved `state` topic, with the state path carried in the message `type`
field ([`space.py:475-515`](https://github.com/reeeductio/reeeductio/blob/main/backend/space.py#L475-L515)). So every account rename,
schedule edit, and categorization override in the space serializes against every other
one.
Keeping the journal in its own topic means a burst of reconciliation edits on your phone
cannot stall a transaction being entered on your laptop, and vice versa.

### Schema sketch

**Space = one set of books.**

A journal entry message (`type: "ledger.entry"`), encrypted before it leaves the client.
The field-by-field spec for this and every other message type is
[SCHEMAS.md](SCHEMAS.md).

```json
{
  "v": 1,
  "date": "2026-09-14",
  "payee": "payee_kR3nQ8vZ1mH7bWxT2yLp",
  "memo": "groceries + household",
  "splits": [
    {"account": "acct_7bQ2xV9mKd4TnR1sYgLp", "amount": "-8423", "exp": 2, "cur": "USD",
     "import_id": "Xk2mP9qR4tV7wY1zA3bC"},
    {"account": "acct_Lm3vT8cHq2NbXr5kYwPd", "amount": "6112", "exp": 2, "cur": "USD"},
    {"account": "acct_9fKwR4tJmQ7vZx2LnBcH", "amount": "2311", "exp": 2, "cur": "USD"}
  ],
  "receipts": [{"blob": "B9ac1…", "dek": "…"}]
}
```

Receipts carry their per-blob DEK (from `encryptAndUploadBlob`) inside the entry, so
whoever can decrypt an entry can open exactly its receipts and no others — which is what
lets a single year's segment be shared on its own.

Invariants the client enforces before posting (the server cannot — it sees ciphertext):

- `sum(amount)` over splits is **exactly zero**, per currency, in integer minor units.
- Every `account` resolves in the chart of accounts at the current state version.
- Each split's `import_id`, when present, is unconsumed — the idempotency key that stops a
  re-imported statement from double-posting. It is a `label("import/v1", …)` (issue 0023),
  never the raw institution ID, so the same statement is still recognized on re-import
  without the server learning the institution's identifiers.

**Corrections** never rewrite history. A `ledger.reversal` message cites a prior
`message_hash` and posts the inverse splits; a replacement `ledger.entry` citing the
original with `replaces` optionally follows.
The register UI collapses the pair and shows the net, exactly as an accounting system
does. "Delete this transaction" becomes "post a reversal" — which is both what the store
permits and what bookkeeping requires. A reversal of an entry that has been edited (see
"Edits and recategorization") must post the inverse of the *effective* accounts, not the
originally posted ones, or the reversal leaves one account debited and another credited. There is no delete-message endpoint, and for state
a delete is expressed as a write of empty data, so even removal is an audited event.

### Reconciliation is an event, not a flag

The obvious design puts a mutable `cleared` flag per transaction in State at
`ledger/txmeta/{label}`. **Don't** — this is the highest-volume mutable thing in the app
(roughly one write per transaction, since every imported transaction eventually clears),
and State is the worst possible home for high-churn data:

- **State's log is append-only, so the cost is permanent.** Every `set_state` is a message
  on the single reserved `state` topic chain. There is no DELETE route for state at all —
  removal is a PUT of empty data, i.e. *another* log entry. So you can never prune a flag's
  replay cost, only add to it. Put per-transaction flags here and the state log grows at
  the same rate as the journal, roughly doubling cold-start replay forever.
- **It all serializes on one chain.** Chart edits and schedule edits queue behind a burst
  of reconciliation flags.

The fix is not a different store — it is noticing that **reconciliation is already an
accounting event.** You reconcile a *statement*, not a transaction: "this account matched
its 2026-09-30 statement, closing balance X, covering these entries." That is immutable,
dated, authored, and worth auditing — a journal-shaped fact. So post it as a message to a
`recon` topic, carrying the set of cleared entry hashes for that statement.

Per-transaction cleared status becomes **derived**, folded from a handful of messages per
account per month instead of one mutable write per transaction. Write volume drops from
O(transactions) to O(statements) — call it 12 messages per account per year — and it lands
on its own chain, contending with nothing. It keeps the audit trail that made State
attractive ("who reconciled this, and when?"), and gains CAS protection State's single
chain would also have given but Data would not.

The genuinely mutable part is only the **in-progress reconciliation session** — the
half-ticked checklist while you work down a statement. That is small (one statement, tens
of items), short-lived, and discarded on completion. It does not belong in the space at
all: keep it in local storage, and post only the completed reconciliation. If you do want
an in-progress session visible across devices, *that* is the right use for **Data** — one
entry at `data/ledger/recon/session/{label}` holding the whole working set, with the
understanding that losing it costs you one redone session.

### What Data is and isn't good for here

Data is the right instinct for keeping State small, but it is not a drop-in for
per-transaction records, for two reasons that are easy to miss:

- **No enumeration, at all.** Data is point read / write / delete by exact path only
  ([`main.py:546-616`](https://github.com/reeeductio/reeeductio/blob/main/backend/main.py#L546)). `list_data(prefix)` exists in the store
  interface, ordered by path, but like `list_state` no route exposes it. So where State at
  least lets you *discover* entries by replaying the log, Data at `data/ledger/recon/{label}`
  gives you no bulk read whatsoever — you would need one HTTP request per transaction and
  no way to learn which txids even have entries. For anything loaded in bulk that is
  strictly worse than replay.
- **No CAS — silent lost updates.** `set_data` is a blind UPDATE-then-INSERT with signature
  verification but no version or head check ([`sql_data_store.py:131`](https://github.com/reeeductio/reeeductio/blob/main/backend/sql_data_store.py#L131)).
  Two devices read-modify-writing one Data document clobber each other with no error. For
  money-adjacent records, a `ChainConflictError` you retry is far better than a write that
  quietly disappears.

So Data earns a real role, just a narrow one: **single-document, bounded, losable or
reconstructible.** Cursors, sync watermarks, projection high-water marks, in-progress
session state — and market price caches, which are bulky but re-fetchable from a public
source (see "Investments and commodities"). The rule of thumb across all three stores:

| Need | Store |
|---|---|
| Immutable, audited, ordered fact about money | **Topic** (own topic if write-hot) |
| Small, mutable, rarely-written config read as one document | **State** (one path, point read) |
| High-churn per-item mutable flag | **Neither** — restructure it into an event |
| Losable or re-fetchable cache, one known path | **Data** |

### Edits and recategorization

Moving a split from Groceries to Dining *changes a balance*, so strictly it should be a
reversal-and-repost. In practice personal finance apps let you retag freely. The design
here is a **Matrix-style edit overlay**, stored as an event in the journal — not as
mutable State.

```json
{"v": 1, "type": "ledger.edit",
 "edits": [
   {"target": "<entry_hash>", "memo": "Thanksgiving groceries"},
   {"target": "<entry_hash>", "splits": {"2": "acct_…Household"}},
   {"target": "<other_hash>", "splits": {"0": "acct_…Dining"}}
 ]}
```

The whole semantics fits in one sentence: **a field's effective value is whatever the most
recent edit naming it says**, in chain order. Edits always target the original entry
(`target` is its `message_hash`, split keys are its split indices), never another edit. The
projection simply updates the row.

**Why an event in `journal`, not State.** The earlier sketch put overrides at
`ledger/txmeta/{label}`. That is per-transaction mutable data in State — the pattern the
reconciliation section rules out — and a bulk recategorization ("all Amazon this year →
Household") would be hundreds of serialized writes on the one shared state chain. As a
journal event it is one message carrying many edits: signed, attributed, CAS-protected, and
totally ordered against the entries it amends, so a checkpoint's journal position covers
both. At ~100 bytes per edit, a few hundred fit comfortably under the server's 100 KB
`max_message_size`; the client splits larger batches across messages. Editing an account
changes no amount, so every entry still sums to zero — the validator checks only *which*
changes are allowed.

**What may be edited, enforced per field by the client before posting:**

| Field | Allowed |
|---|---|
| `memo`, `payee`, `receipts` | Always, including on locked entries — no balance changes |
| A split's `account` | Only income/expense → income/expense, and only on unlocked entries |
| Amount, date, commodity, or any asset/liability/equity account | Never — reversal-and-repost |

The nominal-only rule on split accounts is what makes the overlay safe. Reconciliation
covers asset and liability accounts, so an edit can never move a split off a reconciled
card. Lot IDs are `{hash}#{index}` on asset splits, which edits never touch. And To Be
Budgeted folds budgetable *asset* balances, which are unchanged — only which envelope's
spend a split counts against moves, which is exactly the point of fixing a grocery-vs-dining
mistake. Re-splitting ("$80 Target = $50 groceries + $30 household") changes amounts, so it
is a reversal-and-repost too.

**Closing and locking.** A period close is a message in the `checkpoints` topic citing a
`journal` chain position (in early versions with no balance vector; see Design B). An
entry at or before the latest close position is **locked**: the lock is positional, not
date-based, consistent with checkpoints being defined over chain position. Fixing a
category on a locked entry is a plain new two-split journal entry (`+Dining / −Groceries`)
dated in the open period, with no link to the original — shown as its own register line,
like an accountant's adjusting entry. That case is rare enough that crude is fine.

Edit volume stays low by construction anyway: with import rules, most categorization
happens at approval time, *before* posting, so edits are the exception path — corrections
plus "apply this new rule retroactively".

---

## Opaque identifiers

No user-derived string may appear in a path. Paths are the one part of this design the
server reads in cleartext, so every variable path segment is a **keyed PRF label**,
following the scheme in [absurd-music](https://github.com/cvwright/absurd-music/blob/main/doc/DESIGN.md).

### Derivation

Reusing the SDK's existing convention — HKDF-SHA256 with `"<purpose> | <scope>"` info
strings, in the same two-level tree as `message key | {space}` → `topic key | {topic}`
([`client.py:126-130`](https://github.com/reeeductio/reeeductio/blob/main/python-sdk/reeeductio/client.py#L126-L130)):

```
label_key       = derive_key(symmetric_root, f"label key | {space_id}")
ns_key(ns)      = derive_key(label_key, f"label key | {ns}")
label(ns, s)    = base64url(HMAC-SHA256(ns_key(ns), utf8(s))[:15])
```

The full derivation, the namespace registry (`import/v1`, `allocation/v1`,
`recon-session/v1`, `price/v1`), and test vectors are pinned in [LABELS.md](LABELS.md)
(0005).

`label` does no normalization. Each namespace defines how its input string `s` is built,
and normalizes only the user-derived fields in it: folding the case of an account ID or
a `fitid` would merge distinct values. The `import/v1` input and its normalization are
pinned in [NORMALIZATION.md](NORMALIZATION.md) (0004).

120 bits truncated (15 bytes, so the base64url form is exactly 20 characters with no
partial final character), one key per namespace so a label in one namespace can
neither be correlated with nor used to test guesses in another.

**It must be a keyed PRF, not a hash.** Every identifier in this app comes from a tiny,
guessable space: account names are common English words, merchant strings come from a
public list, and there are only ~1200 plausible `YYYY-MM` values. `SHA256("Groceries")` is
one dictionary lookup, and a plain hash of a month is exhaustively enumerable in
microseconds. HMAC under a key the server does not hold defeats both, and because
`label_key` descends from the space's `symmetric_root`, the same account name in two
different spaces yields unlinkable labels.

### Derive or randomize?

This is where accounting must diverge from the music design. absurd-music derives IDs
*from the natural key* — `artist_` from the normalized artist name, `track_` from the file
hash — because it has no index to consult and wants re-importing the same file to land on
the same ID.

**Account IDs must not work that way.** Journal entries reference accounts forever, so an
account's identity has to survive a rename or a re-parent. Derive `acct_` from the name and
renaming *Groceries* to *Food* mints a new ID and orphans every historical entry
referencing the old one. So **accounts get a random 120-bit ID at creation** — never a
derived one. The cost that usually makes people reach for derivation (needing a name→ID
index) is already paid: the entire chart lives in one encrypted document, so one point read
hands you every binding, and renames touch only that document.

The rule:

- **Derive** when the point is to *recognize the same thing again with no index* —
  import IDs (same `fitid`, or same CSV row, → same label → duplicate detected without a
  lookup).
- **Randomize** when identity must *survive renaming* — accounts, payees, and anything a
  journal entry cites.

Payees were originally on the derive side, keyed by the normalized merchant string. That
fails on real bank data: `SQ *BLUE BOTTLE 0412` and `SQ *BLUE BOTTLE COFFEE 88` are the
same payee, and no fixed normalization knows that — while any heuristic that improves
would change every label. So payees get random IDs in one State document, and **import
rules** (also one State document) map raw merchant strings to payees. The fuzzy matching
lives in editable data; the IDs never move.

### Path rewrite

| Before | After |
|---|---|
| `ledger/txmeta/{txid}` | **gone** — edits moved to `ledger.edit` messages in `journal` |
| `ledger/budgets/{period}/{account}` | **gone** — allocations moved to the `budget` topic; intent lives at the fixed path `ledger/budget`, with no period in any path |
| `ledger/payees/{id}` | **one document** at `ledger/payees`, random `payee_` IDs inside |
| `ledger/staging/{id}` | **gone** — consumption is derived; see "Ingest" |
| `data/ledger/recon/session/{account}` | `data/ledger/recon/session/{label("recon-session/v1", acct_id)}` |
| `Acc_checking`, `Acc_food` | `acct_` + base64url(random 120 bits) |

One general rule survives the removal of `txmeta`, and it is the easiest to wave through:
**never put a `message_hash` raw in a path.** A hash is opaque in content terms, so it
*looks* safe. But it is a value the server assigned and stores, so using it in a path hands
the server an explicit join key: "this entry is about that journal message." If a future
design needs a per-message path, pass the hash through the PRF.

### Where cleartext stays, and why

The small fixed vocabulary of structural segments — `ledger/`, `accounts`, `journal`,
`budget`, `payees`, `rules` — and the topic names `journal`, `recon`, `checkpoints`, `import-staging` stay
cleartext. This is deliberate, and three verified facts drive it:

1. **Capabilities are necessarily server-readable.** The server enforces authorization, so
   it must read capability paths in cleartext ([`authorization.py`](https://github.com/reeeductio/reeeductio/blob/main/backend/authorization.py)).
   Any resource path named in a grant is visible to the server by construction.
2. **Subtree grants need literal prefixes.** `{...}` matches any number of segments, but
   `state/ledger/{...}` only works because `ledger` is a literal. Opaque every segment and
   "write anything under ledger" stops being expressible as one capability — you fall back
   to per-path grants, which is both more auth state and more churn on the one state chain.
   **Opaque paths and subtree capabilities are in direct tension**, and the structural
   prefix is what buys the grant.
3. **Traffic shape gives up the roles anyway.** One hot append-only chain, a rare
   snapshot chain, and a chain only ever written by a tool account are identifiable as
   journal, checkpoints, and import staging from their access patterns alone. Renaming
   them to opaque strings is false comfort.

If you do opaque the topic names regardless, note the encoding constraint: topic IDs are
validated against `^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$`
([`main.py:161`](https://github.com/reeeductio/reeeductio/blob/main/backend/main.py#L161)) — **lowercase only, so base64url is invalid
there.** Use lowercase base32 (26 chars for 128 bits) or hex. State and data path segments
are validated against `^[a-zA-Z0-9._-]+$`
([`path_validation.py:20`](https://github.com/reeeductio/reeeductio/blob/main/backend/path_validation.py#L20)), which base64url satisfies.

### Residual leakage

PRF labels hide *what* an identifier means; they hide nothing about the shape of use. The
server still observes: how many distinct account labels exist (the size of your chart),
which labels are read and written most often (your primary checking account is the busy
one), and write timing and frequency. Message `type` fields are cleartext, so the server
also sees how many entries, edits, reversals, and dismissals you post. This is accepted
rather than hidden: a PRF over a handful of type names still leaks the categories through
their frequencies, and ciphertext size and timing would leak most of the rest anyway.
Allocation events make the monthly budgeting cadence
plain from timestamps alone, even though no path contains a period.
Amounts and balances never appear, since every aggregate is folded client-side.

---

## Concurrency: compare-and-swap is the feature

`add_message` takes the chain head inside the write transaction and rejects the post if
`prev_hash` no longer matches, raising `ChainConflictError` surfaced as "Chain conflict…
get current chain head and retry" ([`space.py:632`](https://github.com/reeeductio/reeeductio/blob/main/backend/space.py#L632)). For most
applications that is a nuisance. For a ledger it is **optimistic concurrency control, for
free**, and it is the thing that makes read-modify-write business rules actually safe:

- *Envelope budgeting.* "Spend from Groceries only if the envelope has room" is a decision
  based on a balance you just derived by folding the `budget` and `journal` topics. If
  another device posts between your read and your write, your decision is stale. CAS turns
  that into a conflict you must retry against the new head — which is the correct
  semantics, and is not something an API with blind `PUT` would give you.
- *Lot depletion.* "Don't sell more of this lot than remains" is the same shape: derive
  `remaining(lot)` by folding disposals, decide, append. If another device sells from the
  same lot in between, the conflict forces the retry.
- *Duplicate-import suppression.* Same structure: check `import_id` unseen, then append.
- *Deterministic replay.* Because the journal is a total order, "balance as of entry N"
  is well-defined and identical on every device. No vector clocks, no CRDT merge, no
  last-writer-wins ambiguity over money.

The cost is that the journal is a single-writer-at-a-time resource per space, and a
multi-device household will hit retries. That is fine at personal-finance write volumes
(a few hundred transactions a month), and the retry is cheap: fetch head, re-validate
invariants, re-sign, re-post. It would *not* be fine for a multi-tenant SaaS ledger
sharing one space — but one space per set of books is the right unit anyway.

State's single shared chain would have been the more likely source of annoyance had
per-transaction data lived there — a bulk recategorization of 500 transactions as 500
serialized state writes. That is why edits are a single `ledger.edit` journal message
instead (see "Edits and recategorization"), and nothing in State scales with transaction
count.

---

## Envelope budgeting

### Accounts are timeless; periods are query windows

There is no "Groceries–September" account. "Groceries" is one account forever, and
September is a filter applied when folding it. Every entry carries a date; the account is
the key you group by, the period is the range you filter to. Same account, three different
questions:

| Question | Account | Window |
|---|---|---|
| What's my checking balance? | Checking | all time |
| What did I spend on groceries in September? | Groceries | Sept 1–30 |
| What's in my groceries envelope? | Groceries envelope | all time |

So nothing period-shaped ever appears in the chart of accounts, and — after the redesign
below — no period appears in any path either.

### Permanent vs. temporary accounts

Standard bookkeeping splits the chart in two, and this is where periods actually attach:

- **Permanent** (or "real") — asset, liability, equity. Balances carry forward forever.
  The balance sheet.
- **Temporary** (or "nominal") — income, expense. **Closed** at period end: zeroed, with
  the net swept into equity. The income statement.

Expense accounts genuinely *are* period-scoped in traditional practice; bank accounts are
not. That asymmetry is the convention baking in a habit of querying — you ask expense
accounts "how much this month?" and asset accounts "what's the balance?"

In an event-sourced ledger **you never perform the close.** Nothing is mutable, so the
reset becomes a filter chosen at read time, and closing the books becomes a *checkpoint* —
which is why checkpoints here are defined over chain position rather than dates.

### Rollover is the absence of a reset

An envelope is not a view of an expense account, because the two answer different
questions. The expense account is a **flow** ("how much did I spend?"); the envelope is a
**stock** ("how much may I spend?"). You cannot read the second off the first, because it
depends on the allocation stream too:

```
envelope_available(e) = Σ allocations to e  −  Σ spend in e's paired expense account
```

Both terms are folds, **unclamped**. Budget 600/month for groceries; spend 550, then 700,
then 500:

| | Sept | Oct | Nov |
|---|---|---|---|
| Allocated / spent | 600 / 550 | 600 / 700 | 600 / 500 |
| Monthly verdict (no rollover) | +50 under | **−100 over** | +100 under |
| Envelope balance (rollover) | 50 | **−50** | 50 |

October is the tell. The monthly view says −100; the envelope says −50, because
September's leftover absorbed half the overspend. Cumulatively 1200 allocated against
1250 spent, so −50 is the true figure.

**Rollover is therefore not a feature you implement — it is what you get by not clamping
the fold.** Non-rollover is the one that costs extra work. Restated in the jargon above:
rollover asks the envelope to behave like a *permanent* account rather than a temporary
one, and the permanent type representing a claim on assets is **equity**. So an envelope
is equity in substance, a stock that carries forward, rather than a view of the expense
account.

### Envelopes partition equity

Allocating 600 to groceries moves no money — checking is identical before and after. What
changed is a *claim* on assets you already held, which is exactly what equity is. This is
textbook fund accounting: one bank account, divided into restricted funds.

**Envelopes are still not accounts in the chart.** No journal split ever posts to one:
an envelope's balance comes only from allocations and the spending in its paired expense
accounts. Kept in the chart, envelopes looked postable and needed rules to stop splits
landing on them, which the budget fold would silently ignore. So they live in
`ledger/budget` with their own `env_` IDs, which a split cannot name. Reports can still
show them as a breakdown of equity.

That yields a checkable invariant, the envelope analogue of splits-sum-to-zero:

```
To Be Budgeted = Σ budgetable asset balances − Σ envelope available balances
```

Credit cards count too: liabilities may be marked budgetable, and their (negative)
balances enter the first sum. Otherwise a card purchase would lower an envelope without
lowering any budgetable balance, and To Be Budgeted would rise.

Paycheck of 1000 → cash 1000, TBB 1000. Allocate 600 → cash 1000, envelope 600, TBB 400.
Spend 550 → cash 450, envelope 50, TBB = 450 − 50 = 400, unchanged — correct, since
spending *from* an envelope must not change what is left to budget. Because TBB is
derived, there is no "Unallocated" account to post into and keep in sync.

### Allocations are events; the schedule is config

The act of budgeting is "on 2025-12-01, 700 was assigned to Groceries" — not "the budget
is 600/month". Those diverge constantly: 650 because you are hosting Thanksgiving, nothing
in a tight month, and above all **moving 50 from Dining to Groceries on the 14th**, the
most common envelope operation and one no schedule can express. Rollover folds *actual*
allocations, so the ledger stores facts.

**Allocations** — `ledger.allocation` on the `budget` topic:

```json
{"v": 1, "date": "2025-12-01", "envelope": "env_Lm3vT8cHq2NbXr5kYwPd",
 "amount": "70000", "exp": 2, "cur": "USD"}
```

These are *earmarks, not money movements*, so they are deliberately exempt from the
sum-to-zero invariant that governs `journal`. That exemption is the reason they live in
their own topic rather than in `journal`: the validator differs.

**Reallocations** — a mid-month move is one `ledger.reallocation`, not two allocations.
Two separate posts could leave a move half done: if the second failed, Dining would be
down 50, Groceries never credited, and To Be Budgeted off by 50. One message is
all-or-nothing, and it states the intent ("moved 50 from Dining to Groceries") rather
than two unrelated adjustments. Its legs must sum to zero, a different validator again,
hence a separate type. It may have more than two legs, to cover one overspend from
several envelopes at once.

**The schedule** — part of the one State document at `ledger/budget`, beside the
envelopes it applies to, holding declarative intent. Despite the name this is plain data:
no substitution, no templating language, nothing Jinja-shaped. It is a dated schedule the
client reads and materializes from.

```json
"env_Lm3vT8cHq2NbXr5kYwPd": {
  "name": "Groceries", "cur": "USD",
  "schedule": [
    {"from": "2024-01", "amount": "60000", "exp": 2},
    {"from": "2025-12", "amount": "70000", "exp": 2}
  ]
}
```

"Monthly grocery budget was 600 through 2024, 700 from December 2025" is expressed once,
as a rule, and edited a few times a year — small, mutable, rarely-written config read as
one document, which is exactly what the single-State-document pattern is for. Same shape
as import rules living in State while imported transactions are events.

Materialization needs an idempotency key, or opening the app on a second device
double-posts the month. Derive it:
`label("allocation/v1", f"{envelope}|{month}")` — the derive-for-idempotency rule from
"Opaque identifiers". The `budget` topic's own chain supplies CAS on the check-then-append.

### Why budget configuration is its own document

The envelopes, the expense-to-envelope pairings, the budgetable set, and the schedule are
one document, `ledger/budget`, rather than fields in the chart. Envelopes take no journal
splits, so nothing about them belongs in the chart, and keeping it all together means
creating an envelope with its pairings and schedule is one write. All of it changes a few
times a year, which is what a single State document suits.

Allocations stay events, not State. Kept in a document, every mid-month envelope move
would rewrite it on the one shared state chain. Budget moves happen several times a
month; configuration changes a few times a year, and that volume gap is the whole premise
that makes a single document sound. It would also grow a timeless document without bound
(10 years × 12 months × N envelopes, point-read on every cold start), and lose the audit
trail where it is most wanted: state history would report "the budget changed", leaving
you to diff documents to find who moved money into Groceries. As allocation events, each
change is signed and attributed.

---

## One ledger, yearly segments

### One logical ledger for all time

Traditional books are kept per year: close the year, carry closing balances into an
opening-balances entry, start fresh. **Don't do that here.** The opening entry turns the
year boundary into a fact inside the books, and everything that spans the boundary then has
to be carried across by hand:

- **Late entries cascade.** The December card statement arrives on January 6 with a missed
  charge. Fixing last year makes this year's opening balances wrong, so you need an
  adjusting entry or a reissued opening entry, plus logic to notice the mismatch.
- **Lots** acquired in 2019 and sold in 2026 must be re-created in every opening entry with
  original acquisition date and remaining basis — minting new lot IDs that disposals then
  need mapped back. Basis conservation would hinge on that carry-forward being exact,
  every year, forever.
- **Envelopes** roll over by an unclamped fold over all history; yearly books need a second
  carry-forward mechanism for allocations.
- **Reconciliation, import dedup, and multi-year reports** all span the boundary anyway.

The per-year habit is inherited from paper, and in software mostly from text-file
performance (ledger-cli and beancount users split files because large ones get slow).
None of that applies to an event log. Everything people want from yearly books already
exists without a hard boundary:

| You want | Answer |
|---|---|
| Starting/ending balances for 2025 | A report: fold with a date window. Nothing stored. |
| "2025 is done, don't let me change it" | Period close plus the positional lock rule |
| Cold start without replaying 2015 | A year-end checkpoint (Design B), citing chain hashes |
| Income/expense reset to zero | A date filter; the close sweep is never performed |

"Year" stays a query window, exactly as months and envelopes already are.

**The one opening entry you do need** is for the day you start using the app: an
`Equity:Opening Balances` entry against each account's balance that day, plus opening
lots carrying their real acquisition dates and basis. Without it the first register is
wrong. It is the same shape yearly books would need every year, posted once.

Since an account holds one commodity, there is one Opening Balances equity account per
commodity, and each commodity balances against its own. An opening lot of 100 VTI is
`+100 VTI` (with `cost` and `acquired`) against `−100 VTI` in the VTI opening account; its
basis rides on the lot, not on a USD split. Only asset and liability accounts are
opened: income and expense start from zero by definition, and envelopes are funded by
allocations (0009).

### Physical segments, aligned to dates

The ledger is logically one, but the journal is **physically split into one topic per
year**: `journal-2025`, `journal-2026`. (Valid under the topic-ID pattern.) This buys two
things:

1. **Bounded per-topic history.** Time-ranged queries over a decade on Firestore are an
   open question; a segment is at most one year. And with a checkpoint, a cold client never
   fetches frozen segments at all.
2. **Cryptographic per-year sharing.** Topic keys are derived one-way,
   `topic_key = HKDF(message_key, "topic key | {topic_id}")`
   ([`client.py:126-130`](https://github.com/reeeductio/reeeductio/blob/main/python-sdk/reeeductio/client.py#L126-L130)), so
   the key for `journal-2025` reveals nothing about any other topic. An accountant can be
   handed exactly one year — not as an authorization rule the server enforces, but as the
   only key they hold. See "Shared books".

Segments are aligned to **dates, not chain position**, because (2) only works if every
2025-dated fact is in `journal-2025`. Rotating at a chain position would avoid ever having
two segments open, but a late 2025 entry would land in the 2026 segment and the per-year
key would no longer cover the year.

There are still no opening-balance entries: balances, lots, and envelopes fold over the
union of all segments, so segments are storage, not books. The rules that make that safe:

- **Routing.** An entry goes to the segment of its `date`'s year. A `ledger.edit` goes to
  its target's segment. A reversal is routed by its own date, which defaults to the
  original's date when the original is unlocked and its segment is open (so it lands in
  the same segment), and to today otherwise. `ledger.dismiss` goes to the segment of the
  staging item's date.
- **Discovery.** There is no route that lists topics, so the years that have a segment
  are listed in one State document, `ledger/journal`. A client adds a year there before
  its first post to that segment, so no segment exists that a reader can't find. That is
  one State write per year, not per transaction (0011).
- **Lifecycle.** A segment is *open* until a **final close** — a close message in
  `checkpoints` citing that segment's head and marked final, typically after taxes are
  filed. Then it is *frozen* and the client refuses to write to it. From January until
  then, two segments are open at once. A late entry for a frozen year becomes an adjusting
  entry in the current year, exactly as for a locked entry.
- **Every order-sensitive rule is intra-segment.** Chain order matters for edits (latest
  wins) and for the lock rule, and routing keeps an edit in its target's segment, so both
  only ever compare positions within one chain. A close cites `(segment, position)`.
  Cross-segment references — lot citations, reversals of frozen entries, `recon` events
  spanning a statement that crosses New Year — are by hash and feed order-independent
  sums.
- **Checkpoints cite every segment head** (plus `budget`), so a cold client can skip every
  frozen segment the checkpoint covers.
- **Each year is self-contained for tax purposes.** A disposal's `from_lots` citations
  carry the lot's acquisition date alongside the quantity, and the basis released is
  already an explicit split, so `journal-2025` alone supports Form 8949 even when the lots
  were bought in 2019. (*Verifying* that basis needs the older segment or a checkpoint
  carrying open lots.)

The cost: CAS covers one segment, so the oversell check on a lot is no longer atomic
across segments. A back-dated December sale into the still-open 2025 segment and a January
sale into 2026 could race on the same lot. For a single user this is negligible; the
client re-validates lot remaining against the union on every disposal, and the books stay
balanced either way — the failure is an oversold lot, detectable by the fold.

---

## The reporting problem

The server stores ciphertext and evaluates no queries, so every aggregation happens on a
trusted client. Worse, and this is the sharp edge:

**There is no prefix or subtree listing over HTTP.** The backend store *has*
`list_state(prefix)` and the authorization layer uses it internally
([`authorization.py:371`](https://github.com/reeeductio/reeeductio/blob/main/backend/authorization.py#L371)), and `Space.list_state`
wraps it ([`space.py:518`](https://github.com/reeeductio/reeeductio/blob/main/backend/space.py#L518)) — but no route exposes it.

So the store offers exactly **two read patterns**, and the schema has to be designed
around them:

1. **Point read at an exact, known path** — `GET /spaces/{id}/state/{path}`. One request,
   but you must already know the path.
2. **Full log replay** — `GET /spaces/{id}/state` and the message endpoints, time-ranged
   on `server_timestamp`, paged at ≤1000. The only way to discover anything.

There is no middle. The design rule that follows: **every bulk read is served by replay,
and every hot read is served by a known path.** Anything that would want a `SELECT … WHERE
prefix` is a schema mistake, not a missing endpoint.

That rule disposes of the enumeration problem entirely. "List my accounts" becomes a point
read of one known path (next section). Reconciliation becomes `recon` topic events read by
time range, not per-transaction entries needing discovery. Edits are `journal` events,
folded by the same replay that builds the projection, at no extra cost. Every hot path is
covered, so the missing prefix route stops being load-bearing.

Note how the rule works: each time something wanted prefix enumeration, the fix was to
restructure the schema — one document, or an event stream — rather than to want a new
endpoint. That is the shape of designing against this store.

### The chart of accounts is one document

Rather than a state entry per account plus a separate index listing them, put **the entire
chart in one state entry** at `ledger/accounts`:

```json
{
  "v": 1,
  "rev": 41,
  "accounts": {
    "acct_7bQ2xV9mKd4TnR1sYgLp": {"name": "Checking",  "type": "asset",   "cur": "USD", "parent": null},
    "acct_Lm3vT8cHq2NbXr5kYwPd": {"name": "Groceries", "type": "expense", "cur": "USD",
                                    "parent": "acct_Qd8nY2rMw5TkVb7xHgLp"},
    "acct_Zj4mH8qLv2NxRt6kYwPd": {"name": "Visa 4421", "type": "liability", "cur": "USD",
                                    "parent": null, "closed_at": "2024-03-02"}
  }
}
```

An index *alongside* per-account entries would work, but it buys nothing and costs
atomicity: creating an account becomes two writes (the account, then the index) that the
store cannot commit together, so a failure between them leaves the index lying about the
chart. Collapsing them removes the problem by construction — one write, atomic, nothing to
drift.

What this gets:

- **One point read** to load the chart. No enumeration needed, ever.
- **One write per change**, so no cross-path atomicity gap.
- **Chart history for free.** State keeps every revision, so "what did the chart look like
  in March?" is answerable — which matters for reproducing a historical report.
- **Contention is a non-issue.** This is the path to *not* worry about: chart edits are a
  handful per year, against the single shared state chain, and nothing else in State is
  write-hot either.

The real cost, and it is worth naming: **it collapses capability granularity for the
chart.** Capabilities are path-scoped, so with one path you can no longer grant someone
write access to one account's definition — it is the whole chart or nothing. For a
household book that is fine; the per-member scoping cases are about journal entries, and
the case that genuinely needs isolation wanted a separate space anyway. Size is not a
concern: a few hundred accounts at ~150 bytes each is tens of KB in one encrypted value.

### Closed accounts stay in the same document

It is tempting to move closed accounts somewhere else — an archive topic, a second
document — to keep the live chart small. **Don't.** A closed account's metadata is still
needed on the read path: any report touching a period when the account was open has to
label and classify its lines, so rendering 2024 requires the definition of the card you
closed in 2024. Splitting it out means every historical report does a second fetch to
reassemble what it just took apart, and the live chart was never big enough to need the
help.

A `closed_at` field and a UI filter is the whole feature. The account stays in the chart;
it disappears from pickers and from current-balance views; history renders unchanged. If a
book ever did grow a pathological number of accounts, shard by account type — the axis
reports actually query along — not by open/closed.

What *does* usefully stop at closure is writing: the client refuses to post new journal
entries against a closed account, and the chart's audit history records who closed it and
when.

### Design A — Full replay into a local projection

The client replays `journal` and the state log from genesis and materializes everything
into local SQLite: balances, registers, budget-vs-actual, payee history. Steady state is
incremental — poll from the last `server_timestamp`, or hold the WebSocket at
`/spaces/{id}/stream`, which broadcasts every committed message
([`main.py:979`](https://github.com/reeeductio/reeeductio/blob/main/backend/main.py#L979)) and makes live multi-device updates nearly
free. Reports then run against local SQL at full speed.

- **Server leakage:** none beyond opaque blobs, opaque state paths, and timing. Strongest
  posture, and the one the product's pitch rests on.
- **Cost:** cold start is **O(entire history)** — every journal entry and every state
  write ever, paged at ≤1000 messages per request, decrypted and folded. For a decade of
  personal finance, plausibly 50k–200k messages. Tolerable on a desktop; painful as the
  first-launch experience on a phone, and paid again on every reinstall.

### Design B — Checkpointed replay

Identical, plus: periodically (monthly, or every N entries) a client posts a
`checkpoints` message containing the full balance vector for every account, the envelope
available balances, the market prices used for any valuation it reports, and the `journal`
and `budget` chain hashes it is valid as of. A cold
client fetches the latest checkpoint, verifies its signature and that the cited hashes are
ancestors of the current heads, loads balances directly, and replays only entries after
it.

Cold start drops to **O(entries since last checkpoint)**. Registers for older periods
load lazily by date range — which the message API supports natively, since queries are
time-ranged on `server_timestamp`.

The trade is trust and discipline. A checkpoint is a *claim* about a fold; believing it
means trusting its signer, so a checkpoint should be signed by a principal the reader
already trusts (ideally the space creator), and any client with full history should verify
checkpoints against its own fold and shout loudly on mismatch.

That verification needs **every figure in a checkpoint to be reproducible**, or two
honest clients compute different checkpoints and fire the tamper alarm on nothing.
Balances are pure sums and so are reproducible for free. Lot basis turns out to be too:
the basis released by each disposal is posted in the journal, so remaining basis is a sum
of posted facts, however it was rounded. Market valuations (`quantity × price`) are exact
products. The checkpoint still names its rounding policy, so that any future computed
figure can say how it was computed and a client can tell "computed differently" from
"computed dishonestly." See [ROUNDING.md](ROUNDING.md). Checkpoints are also the
natural representation of a **closed accounting period**, which is a feature users want
independently. Note the date in a journal entry is user-supplied while ordering is by
server timestamp, so back-dated entries can arrive after a checkpoint covering their
period — the checkpoint must therefore be defined over *chain position*, not over dates,
and a late back-dated entry invalidates derived period reports rather than the checkpoint
itself.

A **period close** is the same message type with the balance vector optional: just the
cited `journal` position and a period label. It exists from milestone 1, before any
checkpoint writer does, because it defines which entries are locked against financial
edits (see "Edits and recategorization").

### Comparison

| | A: Full replay | B: Checkpointed |
|---|---|---|
| Cold start | O(all history) | O(since last checkpoint) |
| Mobile / reinstall | Painful | Viable |
| Trust surface | The chain alone | Chain + checkpoint signer |
| Verifiability | Self-evident from the log | Requires anchor + periodic audit |
| Server leakage | None beyond ciphertext | Same |
| Extra moving parts | None | A checkpoint writer, and an audit path |
| Best when | Desktop-first, one or two devices | Multi-device, long history, mobile |

These are not rivals — B is A plus an optimization, with no privacy
cost, because a checkpoint is just another encrypted message. **Build A, define the
checkpoint message type early, add the writer when cold start starts to hurt.**

---

## Ingest

### CSV import, client-side

The first and possibly only ingest path. The user's own client parses the file, so there
is no trust boundary to enforce and no reason to involve `import-staging`:

1. Upload the raw CSV as a blob, so the source stays auditable.
2. Parse it with the account's mapping profile, and compute an import ID per row:
   the `fitid` when the file has one, otherwise one derived from the row itself (account,
   date, amount, normalized description, and an occurrence count within that date). See
   issue 0023 for the details and the pending-transaction problem.
3. Drop rows whose import ID is already posted or dismissed in the projection.
4. Review locally: apply import rules (merchant string → payee and category), match
   against existing entries (to catch the manually entered transaction that just
   cleared, or the other side of a transfer), and **the user approves**. Approval posts a
   `ledger.entry` whose split carries the `import_id` label; a match posts a `ledger.edit`
   setting the label on the existing split. See [SCHEMAS.md](SCHEMAS.md).
5. Consumption is **derived, not stored.** A row is consumed iff some split carries its
   `import_id` label. "Ignore this one" (a duplicate, a pending charge that never
   posted) is a `ledger.dismiss` message in `journal` citing the same label. An earlier
   sketch marked consumption in State at `ledger/staging/{label}`; that is one State write
   per imported transaction, breaking the rule that nothing in State scales with
   transaction count.

### Bank sync as a tool account (future, maybe never)

If automated bank sync is ever built, the tool-account primitive fits it unusually well. A
sync worker (Plaid/SimpleFIN puller) gets a **tool** identity whose capabilities are
create-only on `topics/import-staging` plus `create` on blobs — and nothing else. It
cannot read the journal, cannot touch the chart of accounts, cannot modify anything
already written. If the worker is compromised, the blast radius is "junk appears in the
staging queue". It is also the **sole writer** of `import-staging`, so that chain never
conflicts.

The worker uploads the raw statement as a blob and appends one staging message per
institution transaction, carrying the `fitid`. From there the flow is the CSV flow from
step 3 on, reading rows from `import-staging` instead of a local file. Dismissals still go
in `journal`, not `import-staging`, which must keep the tool account as its sole writer.

Keeping approval client-side is what preserves the invariant that nothing enters the
journal unbalanced or uncategorized — and the server could never check that anyway.

Note that a worker pulling from a bank API needs that institution's credentials, which it
must hold in plaintext at runtime. Those can be stored encrypted in the space
(`set_encrypted_state`) only if the worker holds the symmetric root — at which point it
can read everything, defeating the capability scoping above. **Keep sync credentials
outside the space**, in the worker's own secret store, and let the worker hold only its
Ed25519 identity. A tool account that cannot decrypt the books is the whole point.

---

## Shared books

The capability system maps onto the real sharing cases cleanly, because capabilities are
path-scoped with `{self}` and wildcard matching:

- **Spouse, full partner.** Role with `write` on `topics/journal` and `state/ledger/{...}`.
  Both parties post to the same chain; CAS handles the races. Attribution is automatic —
  every entry is signed, so "who entered this?" is answerable forever.
- **Bookkeeper.** `write` on `topics/journal` but `read` on `state/ledger/accounts`: can
  post transactions, cannot restructure the chart of accounts. Note this is exactly the
  granularity the single-document chart still supports — whole-chart read vs. write — and
  the only one it supports.
- **Accountant at tax year end.** Role with `read` on `topics/journal-2025` and
  `state/ledger/{...}`, and — crucially — handed only the **topic keys** for
  `journal-2025` and `state`, not the symmetric root. They can decrypt that year's entries
  and receipts (whose DEKs are inside the entries) and the chart, and nothing else: no
  other year, no `budget`, no Data, no label key. Revoke the role after filing. The
  tamper-evidence is the selling point here: they can verify the segment's chain
  themselves rather than trusting an exported CSV. (The state key does expose the full
  chart, payee, and rules history across all years; that is metadata, not transactions,
  and acceptable.) This needs an SDK client mode constructed from explicit topic keys
  rather than a symmetric root — see open questions.
- **A kid's allowance ledger.** Its own space, not a scoped path. Postings are `journal`
  messages, and topic capabilities can't scope a writer to "only entries touching my
  accounts" — the server can't read splits. A separate space also gives the read
  compartment that the caveat below says paths cannot.

Two caveats. First, revocation is *authorization*, not *confidentiality*: a departing
party can still decrypt everything they synced with the keys they held. Revoking an
accountant's role stops new reads; it does not unsee the year. Any flow where more than
that matters needs a re-key, which is a space-level concern outside this note. Second,
participants who hold the symmetric root can derive every key, so for them capability
scoping limits what they can *write* and what the server will *serve* — it does not
create read compartments. Real read compartments exist only at topic granularity, by
handing out topic keys instead of the root, as for the accountant. A ledger a teenager
genuinely shouldn't see belongs in a separate space, not a scoped path.

---

## Numbers, currencies, and commodities

### The journal is closed under addition

The governing invariant, and the reason arbitrary-precision integers suffice everywhere in
the ledger: **posting only ever adds and subtracts.** Rates, percentages, interest, APY and
fees are computed by somebody else — the bank, the broker, the exchange — and arrive as
amounts already decided. You record the amount, never the rate.

This holds more broadly than it first appears. A currency conversion needs no arithmetic
either: both legs are amounts you actually paid and received, straight off the statement,
and the implied rate is a derived display quantity rather than an input. Same for a stock
split, which under the "total cost, never per-share" rule changes only a quantity and
leaves basis untouched.

Floating point is fine for projections, forecasts, IRR, CAGR, allocation percentages and
valuation display — on one condition: **a float never becomes a ledger fact.** It may be
shown, but it may not be posted.

There is exactly one exception, and it lives in the core ledger rather than in reporting:
**partial lot disposal** divides, because you choose which lots to draw from. See "Basis
conservation" below.

### Representation rules

Non-negotiable, and the most common way personal finance apps get silently wrong:

- **Never floats.** Store integer minor units with an explicit exponent per split
  (`{amount: -8423, exp: 2}`). JSON numbers are IEEE doubles in most parsers, so even the
  serialization must be integers-plus-scale, or decimal strings. Since the data is
  encrypted blobs the format is entirely the app's choice — use it.
- **Balance per commodity, not per account.** An account holding both USD and 3.5 shares
  of VTI has two balances. Multi-currency entries balance *per currency*, with the
  exchange rate recorded on the entry as a split pair through a trading account — the
  standard double-entry treatment, and it keeps "sum to zero" literally true.
- **Exponent 2 is not universal.** JPY is 0, KWD is 3, crypto is 8–18. Carry the exponent;
  don't infer it from the currency code at read time. The Ethereum ecosystem learned this
  the hard way: `parseUnits(value, decimals)` exists in general form alongside
  `parseEther` precisely because token decimals vary (USDC 6, WBTC 8, most ERC-20 18).
- **`BigInt` in memory, decimal strings on the wire.** `JSON.stringify({x: 1n})` throws
  `TypeError: Do not know how to serialize a BigInt` — which is why viem ships its own
  `Json.stringify`/`Json.parse` with bigint support. Serialize amounts as decimal strings
  and parse to `BigInt` at the boundary, in one codec at the encrypt/decrypt edge.
- **Division truncates, so rounding must be a decision.** `BigInt` is integer-only, won't
  mix with `number`, and has no `Math.*` — all useful safety properties. But any price
  multiplication needs an explicit scale-up → multiply → divide with a documented rounding
  rule, and sum-to-zero forces remainders to be allocated deliberately: splitting $10
  three ways is 334/333/333, not three independent roundings.

- **The projection store has its own 64-bit limit.** This is the one that will actually
  bite, because `BigInt` in memory lulls you into thinking the problem is solved. SQLite's
  `INTEGER` is signed 64-bit, so a Design A projection holding wei as `INTEGER` silently
  breaks above roughly **9.2 ETH**:

  ```
  int64 max =  9,223,372,036,854,775,807
    1 ETH   =  1,000,000,000,000,000,000 wei   ✓ fits
   10 ETH   = 10,000,000,000,000,000,000 wei   ✗ overflows
  ```

  A threshold you cross in testing and misread as a display bug. Store amounts as `TEXT`
  or `BLOB` in the projection, or keep crypto at a coarser exponent than native. The
  boundary to SQLite needs the same discipline as the boundary to JSON.

The SDK itself is unaffected — every `number` in the TypeScript types is a timestamp or a
limit, comfortably inside 2⁵³, and amounts never pass through the SDK because they live
inside app-defined ciphertext. The whole burden is the app's payload codec.

---

## Investments and commodities

Stocks, ETFs, and crypto are where "balances are derived" pays off most. One distinction
matters more than all the others: **three facts belong in the journal, and one must stay
out of it.**

| Fact | Home | Why |
|---|---|---|
| Quantities held | `journal` | Real events — you bought 100 shares |
| Cost basis per lot | `journal` | What you actually paid; authoritative, tax-relevant, immutable |
| **Realized** gain on disposal | `journal` | A real event with a date |
| **Market price, unrealized gain** | **not the journal** | Not an event in your books — an external observation |

Price changes are not transactions. Post them as entries and the journal grows without
bound, polluted with facts you did not cause. Unrealized gain is a *report*:
`Σ(quantity × price) − cost basis`, computed at read time and never stored.

### Currency is one commodity among many

An account's balance is a quantity of a commodity; USD is simply one, alongside VTI and
BTC. Entries balance **per commodity**, with trading accounts absorbing the conversion.
This keeps sum-to-zero literally true and integer-only, with no currency conversion or
rounding inside the validator — which matters because the validator is client-side and the
server can never check it.

Buy 100 VTI at $50:

```
Assets:Brokerage:VTI    +100 VTI    cost: "500000" exp2 USD, acquired: 2026-10-03
Trading:VTI             −100 VTI
Trading:USD            +5000 USD
Assets:Brokerage:Cash  −5000 USD
```

VTI nets zero; USD nets zero. Store each lot's **total** cost, never per-share — per-share
is derived for display, so no rounding error creeps into basis.

Sell 50 of that lot at $70:

```
Assets:Brokerage:VTI     −50 VTI    from_lots: [{lot: "M…#0", qty: 50, acquired: 2026-10-03}]
Trading:VTI              +50 VTI
Trading:USD           −2500 USD     ← basis of the lots drawn
Assets:Brokerage:Cash +3500 USD     ← proceeds
Income:CapitalGains   −1000 USD     ← proceeds − basis
```

USD: −2500 + 3500 − 1000 = 0. The gain is explicit in the entry, computed by the client
from the cited lots rather than stored anywhere.

### Lot remaining quantity is derived

This is the part that will tempt you into mutable state. A lot is created by a journal
entry and identified `{message_hash}#{split_index}`, since one entry may create several. A
disposal cites lots by that id. Then:

```
remaining(lot) = original_qty − Σ qty drawn by every disposal citing it
```

A fold — never stored, never mutated. Which yields a third compare-and-swap case alongside
envelope room and duplicate-import suppression: "don't oversell this lot" is
derive-a-balance, decide, append, with the chain forcing a retry if another device sells
from the same lot in between.

One subtlety the chain design creates: a `message_hash` changes when a post is retried
against a new `prev_hash`, so **lot ids are stable once committed but not across a retry.**
Never persist a lot id before the post succeeds.

### Basis conservation

Partial disposal is the single place the ledger divides. Selling 3 shares of a 7-share lot
that cost $1,000 releases `1000 × 3/7 = 428.57…` of basis, and that figure has to make the
entry sum to zero.

Rounding each disposal independently against the original lot **leaks basis**, so a
fully-depleted lot's released basis does not sum to what you paid:

| Lot | Sold as | Independent rounding | Running remainder |
|---|---|---|---|
| 3 shares @ $1,000 | 1, 1, 1 | **leaks 1¢** | exact |
| 7 shares @ $1,000 | 3, 3, 1 | **leaks 1¢** | exact |
| 6 shares @ $1.00 | 1 × 6 | **leaks 4¢** | exact |
| 1000 @ $1,234.57 | 333, 333, 334 | **leaks 1¢** | exact |

A leak is a wrong realized gain, which is a tax error — tiny per event, cumulative, and
silent. The rule, which composes with deriving quantity remaining:

```
basis_released = floor(remaining_cost × qty / remaining_qty)
                 — or all of remaining_cost when the disposal depletes the lot
```

Compute against what *remains*, not against the original lot, and let a depleting disposal
take whatever is left. **Round one side and let the other absorb it**, so conservation
holds by construction rather than by luck. Basis remaining is then derived exactly as
quantity remaining is: `lot_cost − Σ basis released`.

The scale, the floor direction, the order in which a lot's draws are checked, and the
test vectors are pinned in [ROUNDING.md](ROUNDING.md) (0003).

### Prices live outside the ledger

Daily closes for 20 holdings over 10 years is ~50,000 points — it would dwarf a journal of
a few thousand entries, and every one of them is re-fetchable from a public source. So
price history does not go in the space. Cache it locally, with two refinements:

- **Checkpoints carry the prices they used**, which is what makes a historical net-worth
  snapshot reproducible without retaining every quote.
- **For a shared cache**, so two devices don't each fetch, use **Data** — one entry per
  `(commodity, year)` at `label("price/v1", "VTI|2026")`. Data has no chain and no history, so
  the writes never bloat replay, and losing it is harmless. Per-year documents also dodge
  Data's no-enumeration problem: a 10-year series is 10 point reads, not 2,500.

Note the division of labor. **Cost basis is a journal fact** — authoritative, signed,
immutable, tax-relevant. **Market price is reference data** — external, non-authoritative,
reconstructible. Conflating the two is the root of most investment-tracking confusion.

### Stocks and ETFs

Mechanically identical. Cash dividends are a plain two-split income entry; DRIP is that
plus a buy.

**Stock splits don't balance.** A 2:1 takes 100 shares to 200 with no money moving, so it
is a `ledger.lotadjust` message exempt from per-commodity sum-to-zero — the same exemption
`ledger.allocation` gets, and for the same reason: no economic event occurred. Total basis
is unchanged, and **the original acquisition date carries over**, which preserves
long-term holding-period treatment. Return of capital reduces basis rather than being
income.

### Crypto

Two traps beyond the ordinary.

**Precision overflows doubles.** BTC is 8 decimals, ETH 18 — and 1 ETH = 10¹⁸ wei while
2⁵³ ≈ 9×10¹⁵, so anything above roughly 0.009 ETH exceeds exact integer range in an IEEE
double. The integers-not-floats rule bites far harder here than it does for dollars; see
"Numbers, currencies, and commodities" for the `BigInt`-and-strings handling the JS
ecosystem settled on.

**Every disposal is taxable**, including crypto-to-crypto, so a swap is a disposal joined
to an acquisition at a single fair value:

```
Assets:Crypto:BTC    −0.5 BTC    from_lots: […]
Trading:BTC          +0.5 BTC
Trading:USD       −20000 USD     ← basis released
Income:CapitalGains −12000 USD   ← fair value − basis
Trading:USD       +32000 USD     ← proceeds = cost of the ETH
Assets:Crypto:ETH     +10 ETH    cost: "32000" USD
Trading:ETH          −10 ETH
```

Staking rewards and airdrops are income at fair value on receipt, creating a new lot
carrying that basis.

### Out of scope

Each of these is a real tax requirement that deserves its own decision rather than being
half-implemented:

- **Bonds.** Coupons-as-income on receipt would be easy, but premium/discount amortization
  is genuine accrual accounting, and accrued interest paid to a seller at purchase is not
  basis (it offsets the first coupon). Excluded deliberately rather than approximated.
- **Wash sales** — the 30-day rule disallowing a loss and adjusting basis.
- **Mergers and spinoffs** — basis allocation across resulting positions.
- **Multi-jurisdiction lot rules** — lot-selection methods differ by country.

---

## What to build first

1. **Chart of accounts + manual journal entry + register view**, Design A replay, desktop
   client. This exercises every primitive (state, topic, chain conflict, signatures) and
   is a usable app for one person. Includes reversals, `ledger.edit`, the period close
   message (so the lock rule works from day one), the opening-balances entry, and
   yearly `journal-YYYY` segments from the first post, so there is never a migration.
2. **Statement reconciliation** as `recon` topic events, with the in-progress session kept
   local — proves the derive-don't-store discipline and the audit story.
3. **CSV import**, client-side, with local review and approval — proves the idempotency
   key and the rules-to-payee mapping. OFX later; a bank-sync tool account maybe never.
4. **Envelope budgeting** — `budget` topic allocations plus the `ledger/budget` document. Do this
   *after* the register view, since it is a fold over two topics and wants the projection
   working first.
5. **Investments** — commodity accounts, lots, and derived lot depletion. Independent of
   budgeting; do whichever the user needs first. Write the basis-conservation tests first:
   deplete a lot across several partial sales and assert released basis sums to cost
   exactly.
6. **Checkpoints**, when cold start gets annoying. Define the message type in step 1
   regardless.
7. **Sharing** — second user, roles, and the accountant read-only hand-off, which is the
   story no competitor can tell.

---

## Open questions / follow-ups

- **Prefix listing is now a convenience, not a blocker.** The single-document chart and
  replay-driven overlay cover both hot paths, so this app no longer needs it. Still worth
  exposing eventually — `list_state(prefix)` already exists and is used internally, and a
  `GET /spaces/{id}/state?prefix=…` route would pair well with a batch-get
  endpoint — but it is no longer on this app's critical path.
- **Does state's single chain become the bottleneck?** Settled by construction:
  reconciliation is `recon` events, allocations are `budget` events, edits are
  `ledger.edit` journal events, and import consumption is derived. State holds only the
  chart, the list of journal years, the budget configuration, payees, and rules. The discipline to hold: **anything whose
  write volume scales with transaction count does not go in State**, because the log is
  append-only and its replay cost can never be pruned. A multi-path atomic state write
  would still be nice for general consistency, but nothing here needs it.
- **Label rotation.** PRF labels are stable for the life of the space, so the server
  accumulates a long access-pattern history against each one. Rotating `label_key` would
  break that, but it rewrites every path in the space — and because the state log is
  append-only, the old labels stay in the log forever anyway. Probably not worth it; worth
  deciding explicitly rather than by omission.
- **Pin the rounding policy early.** Resolved in [ROUNDING.md](ROUNDING.md) (0003): floor
  at the lot cost's exponent, with the lot keeping the remainder until the depleting draw.
  Checkpoint reproducibility turned out not to depend on it, since released basis is
  posted.
- **Normalization is part of the security boundary.** Resolved in
  [NORMALIZATION.md](NORMALIZATION.md) (0004): NFKC, locale-free `toLowerCase`, a pinned
  whitespace set collapsed and trimmed, and punctuation left alone. It is versioned in the
  namespace string, `import/v1`, which also pins the whole label input. Payees don't
  depend on it, since they have random IDs.
- **Checkpoint trust model.** Who may sign a checkpoint, how a client proves the cited
  chain hash is an ancestor of the current head without replaying to it, and what a
  client does on a mismatch. Needs to be pinned down before step 4.
- **Journal entry size vs. message overhead.** A 3-split transaction is a few hundred
  bytes of plaintext. Confirm per-message overhead (hash, signature, timestamps, base64
  expansion) is acceptable at ~100k messages, and check how the time-ranged message query
  performs over a decade of history with the Firestore backend as well as SQLite. Yearly
  segments bound each topic to one year, which makes this much less likely to matter.
- **SDK client from topic keys — deferred indefinitely.** Both SDKs construct a client
  from `symmetric_root` and derive every key from it. Per-year sharing needs a mode that
  takes explicit topic keys (and the state key) instead. The implementation can wait; the
  data model must not, so these rules hold from the first post:
  1. **Everything needed to read a year lives in that year's segment or in State.** Edits,
     dismissals, and same-year reversals route to the target's segment; receipts carry
     their DEK in the entry; disposals carry lot acquisition dates; payee and account
     references resolve against State documents.
  2. **Nothing a segment reader needs is encrypted under a root-derived key** other than
     the segment's topic key and the state key — not the data key, not `label_key`.
     Labels appear in entries only as opaque references that resolve to State paths, so a
     reader never needs to *compute* one.
  3. **Entries never embed secrets for other topics** — no keys, and no plaintext copied
     from another year beyond what rule 1 requires.
  4. **Non-shared topics stay unsegmented.** `recon`, `budget`, `checkpoints`, and
     `import-staging` are not per-year; an accountant does not need them. If verifying
     basis against a checkpoint ever needs to be shareable, segment `checkpoints` the same
     way — a cheap change, since a checkpoint is never cited by anything but its reader.
- **Oversell race across open segments.** CAS is per segment, so a lot can in principle be
  oversold by concurrent disposals into two open segments. Detected by the fold, not
  prevented; revisit if shared books make it plausible.
