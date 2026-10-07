# 0049: Suggest categories for imported rows

## Context

Import review (0022) fills a row's category only when an explicit rule
(0021, `categorize` in `src/core/rules.ts`) matches. Every other row
starts as "Choose", so a first import, before any rules exist, means
categorizing every row by hand.

Two parts are needed: an **inference engine** that suggests a category
(and maybe a payee) for a row with no matching rule, and an **initial
seed** so that it is useful on day one, before the user has any
history. This issue lists the options for both. None is chosen yet.

Related: 0048 (starter categories), which a built-in seed would map
onto.

## Prior art

- **Rules only**: hledger CSV rules, Firefly III, icsv2ledger (which
  appends a mapping when the user categorizes an unknown row).
- **Same payee as last time**: `ledger convert`, ledger-autosync,
  KMyMoney (default category per payee, matched by name or keywords),
  Actual Budget (turns consistent categorization into payee rules).
- **Classifier trained on the user's ledger**: GnuCash (Bayesian
  token matching in the import matcher), reckon (Bayesian, for
  ledger), Beancount's `smart_importer` (scikit-learn SVM) and
  `beancount-import`.

## Options: inference engine

These can be combined. Explicit rules should always win.

- **A. Payee or description history.** Suggest the account used most
  often or most recently with the same payee or normalized
  description on this account. Cheap and predictable.
- **B. Naive Bayes over description tokens.** Token-to-account
  counts learned from the user's categorized entries, as in GnuCash
  and reckon. Copes better with noisy bank descriptions (store
  numbers, city names, card suffixes) than an exact match.
- **C. Merchant heuristics with amount priors.** Built-in patterns
  for common merchants (grocery chains, fast food, fuel, streaming,
  utilities), each with a category and a typical amount range. The
  amount is evidence: $8 at a merchant that also sells fuel suggests
  snacks or dining, and $55 suggests fuel. Could also be a feature in
  B rather than a separate engine.
- **D. Learned rules.** When the user categorizes the same
  description or payee the same way several times, propose (or
  create) an explicit rule, as Actual does. The output is visible and
  editable in 0047's rule manager rather than opaque.

## Options: initial seed

- **1. Built-in merchant list.** Static data shipped with the app:
  merchant patterns, a category, and an amount range. Feeds engine C,
  or primes B's counts. Needs a region or locale, since merchant names
  are regional.
- **2. The user's own history.** No seed. The engine starts working
  once entries exist (from manual entry, earlier imports, or a
  migration).
- **3. A historical import.** Import and categorize a few months of
  statements first, then train on them. Same as 2, but done
  deliberately as part of onboarding.
- **4. Starter rules.** Seed `ledger/rules` with explicit rules for
  common merchants when the starter categories are created (0048).
  Uses the existing engine. The rules are visible, editable, and
  posted like any other rules.

## Constraints

- Everything runs on the device. No description or amount leaves it.
- A learned model is derived from the journal, so it belongs in the
  projection (rebuildable, behind `PROJECTION_VERSION`) or in memory,
  never in State, because its size scales with transaction count.
- The engine itself is pure core code, with vitest coverage.
- A built-in seed refers to categories by starter name, but accounts
  are renamed and their IDs are random. The seed needs a mapping from
  its category keys to account IDs: recorded when 0048 creates the
  accounts, or chosen by the user.
- Amounts in the seed and the engine are integers with an exponent,
  never floats, and are per commodity.

## Open questions

- Is a suggestion shown differently from a rule's choice (for example
  marked "suggested"), and does it need a tick to accept it, or is it
  approved with the row like a rule's?
- Should the suggestion carry a confidence, and below what threshold
  is the row left as "Choose"?
- Where does the merchant list come from, and how is it kept up to
  date and regional?
