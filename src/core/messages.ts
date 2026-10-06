/**
 * Every message type and State document in design/SCHEMAS.md, decoded into typed values
 * and encoded back to JSON.
 *
 * Decoding checks shape and type only: the fields, their primitive types, and per-field
 * rules such as "non-empty" or "must not be zero". A value that fails is malformed and is
 * rejected whole. Rules that need the chart or other messages are fold-time rules, in
 * validate.ts and the folds.
 *
 * In memory, an amount spread over a message's own fields keeps the wire names, with
 * `amount` as a `bigint`. So a `Split` is structurally an `Amount`.
 */

import type { Amount, Commodity } from './amount.js';
import { CodecError } from './errors.js';
import {
  isAccountId, isBlobId, isDek, isEnvelopeId, isIsoDate, isLabel, isLotId, isMonth, isMsgId,
  isPayeeId, isRuleId, segmentYear,
  type AccountId, type BlobRef, type EnvelopeId, type IsoDate, type Label, type LotId,
  type Month, type MsgId, type PayeeId, type RuleId,
} from './ids.js';
import { parseJson, toWire, stringifyJson } from './json.js';
import { normalizeDescription } from './normalize.js';
import {
  amount, arrayOf, boolean, commodity, count, exp, guard, int, isPlainObject, literal,
  nonEmptyString, nonZeroInt, nullable, object, oneOf, posInt, record, refine, string,
  type Decoder,
} from './schema.js';

/** A message or document whose `v` this client doesn't know. The fold must stop. */
export class UnknownVersionError extends CodecError {
  constructor(readonly v: number, path = 'v') {
    super(`unknown version ${v}`, path);
    this.name = 'UnknownVersionError';
  }
}

/** A message type this client doesn't know. Like an unknown `v`, the fold must stop. */
export class UnknownTypeError extends CodecError {
  constructor(readonly type: string) {
    super(`unknown message type "${type}"`);
    this.name = 'UnknownTypeError';
  }
}

// --- Primitives -----------------------------------------------------------------------

const date = guard(isIsoDate, 'a Date (YYYY-MM-DD)');
const month = guard(isMonth, 'a Month (YYYY-MM)');
const msgId = guard(isMsgId, 'a MsgId');
const lotId = guard(isLotId, 'a LotId');
const accountId = guard(isAccountId, 'an AccountId');
const envelopeId = guard(isEnvelopeId, 'an EnvelopeId');
const payeeId = guard(isPayeeId, 'a PayeeId');
const ruleId = guard(isRuleId, 'a RuleId');
const label = guard(isLabel, 'a Label');
const splitIndex = (k: string): k is `${number}` => /^(0|[1-9][0-9]*)$/.test(k);

const blobRef: Decoder<BlobRef> = object({
  blob: guard(isBlobId, 'a blob ID'),
  dek: guard(isDek, 'a 32-byte base64url key'),
});

/** `v`: `1`, or an `UnknownVersionError` for any other integer. */
const v1: Decoder<1> = (v, path) => {
  if (typeof v === 'number' && Number.isInteger(v) && v !== 1) throw new UnknownVersionError(v, path);
  return literal(1)(v, path);
};

const rev = refine(count, (n) => (n >= 1 ? undefined : 'rev starts at 1'));

/**
 * Checks `v` before anything else, so a newer message with fields this client doesn't
 * know is reported as an unknown version, not as malformed.
 */
function versioned<T>(d: Decoder<T>): Decoder<T> {
  return (v, path) => {
    if (isPlainObject(v) && Object.hasOwn(v, 'v')) v1(v.v, path ? `${path}.v` : 'v');
    return d(v, path);
  };
}

// --- Journal segment messages ---------------------------------------------------------

export interface LotDraw {
  readonly lot: LotId;
  readonly qty: bigint;
  readonly acquired: IsoDate;
  readonly basis: Amount;
}

export interface Split {
  readonly account: AccountId;
  readonly amount: bigint;
  readonly exp: number;
  readonly cur: Commodity;
  readonly cost?: Amount;
  readonly acquired?: IsoDate;
  readonly from_lots?: readonly LotDraw[];
  readonly import_id?: Label;
}

export interface Entry {
  readonly v: 1;
  readonly date: IsoDate;
  readonly splits: readonly Split[];
  readonly payee?: PayeeId;
  readonly memo?: string;
  readonly receipts?: readonly BlobRef[];
  readonly source?: BlobRef;
  readonly replaces?: MsgId;
}

export type ReversalSplit = Omit<Split, 'cost' | 'acquired' | 'from_lots'>;

export interface Reversal {
  readonly v: 1;
  readonly date: IsoDate;
  readonly reverses: MsgId;
  readonly splits: readonly ReversalSplit[];
  readonly memo?: string;
}

export interface Edit {
  readonly target: MsgId;
  readonly memo?: string | null;
  readonly payee?: PayeeId | null;
  readonly receipts?: readonly BlobRef[];
  /** Split index (decimal string) to the new account. */
  readonly splits?: Readonly<Record<string, AccountId>>;
  /** Split index (decimal string) to the import label that confirms it. */
  readonly import_ids?: Readonly<Record<string, Label>>;
}

export interface EditMessage {
  readonly v: 1;
  readonly edits: readonly Edit[];
}

export interface Dismiss {
  readonly v: 1;
  readonly import_ids: readonly Label[];
}

export interface LotAdjustment {
  readonly lot: LotId;
  readonly account: AccountId;
  readonly exp: number;
  readonly cur: Commodity;
  readonly old_qty: bigint;
  readonly new_qty: bigint;
}

export interface LotAdjust {
  readonly v: 1;
  readonly date: IsoDate;
  readonly adjustments: readonly LotAdjustment[];
  readonly memo?: string;
}

const lotDraw: Decoder<LotDraw> = object({ lot: lotId, qty: posInt, acquired: date, basis: amount });

const splitFields = { account: accountId, amount: nonZeroInt, exp, cur: commodity };

const split: Decoder<Split> = object(splitFields, {
  cost: amount,
  acquired: date,
  from_lots: arrayOf(lotDraw, { min: 1 }),
  import_id: label,
});

const reversalSplit: Decoder<ReversalSplit> = object(splitFields, { import_id: label });

export const decodeEntry: Decoder<Entry> = versioned(
  object(
    { v: v1, date, splits: arrayOf(split, { min: 2 }) },
    {
      payee: payeeId,
      memo: nonEmptyString,
      receipts: arrayOf(blobRef, { min: 1 }),
      source: blobRef,
      replaces: msgId,
    },
  ),
);

export const decodeReversal: Decoder<Reversal> = versioned(
  object(
    { v: v1, date, reverses: msgId, splits: arrayOf(reversalSplit, { min: 2 }) },
    { memo: nonEmptyString },
  ),
);

const edit: Decoder<Edit> = refine(
  object(
    { target: msgId },
    {
      memo: nullable(nonEmptyString),
      payee: nullable(payeeId),
      receipts: arrayOf(blobRef),
      splits: record(splitIndex, accountId, { min: 1 }),
      import_ids: record(splitIndex, label, { min: 1 }),
    },
  ),
  (e) => (Object.keys(e).length > 1 ? undefined : 'an edit changes at least one field'),
);

export const decodeEditMessage: Decoder<EditMessage> = versioned(
  object({ v: v1, edits: arrayOf(edit, { min: 1 }) }),
);

export const decodeDismiss: Decoder<Dismiss> = versioned(
  object({ v: v1, import_ids: arrayOf(label, { min: 1, uniqueBy: (x) => x }) }),
);

const lotAdjustment: Decoder<LotAdjustment> = object({
  lot: lotId,
  account: accountId,
  exp,
  cur: commodity,
  old_qty: posInt,
  new_qty: posInt,
});

export const decodeLotAdjust: Decoder<LotAdjust> = versioned(
  object(
    { v: v1, date, adjustments: arrayOf(lotAdjustment, { min: 1 }) },
    { memo: nonEmptyString },
  ),
);

// --- Other topics ---------------------------------------------------------------------

export interface Allocation {
  readonly v: 1;
  readonly date: IsoDate;
  readonly envelope: EnvelopeId;
  readonly amount: bigint;
  readonly exp: number;
  readonly cur: Commodity;
  readonly idem?: Label;
  readonly memo?: string;
}

export interface Recon {
  readonly v: 1;
  readonly account: AccountId;
  readonly statement_date: IsoDate;
  readonly closing_balance: Amount;
  readonly cleared: readonly MsgId[];
  readonly statement?: BlobRef;
  readonly supersedes?: MsgId;
}

export interface Head {
  readonly topic: string;
  readonly hash: MsgId;
  readonly final?: true;
}

export interface Balance {
  readonly account: AccountId;
  readonly amount: bigint;
  readonly exp: number;
  readonly cur: Commodity;
}

export interface EnvelopeBalance {
  readonly envelope: EnvelopeId;
  readonly amount: bigint;
  readonly exp: number;
  readonly cur: Commodity;
}

export interface OpenLot {
  readonly lot: LotId;
  readonly account: AccountId;
  readonly qty: bigint;
  readonly exp: number;
  readonly cur: Commodity;
  readonly basis: Amount;
  readonly acquired: IsoDate;
}

export interface Price {
  readonly commodity: Commodity;
  readonly date: IsoDate;
  readonly price: Amount;
}

export interface Checkpoint {
  readonly v: 1;
  readonly period: string;
  readonly rounding: string;
  readonly heads: readonly Head[];
  readonly balances?: readonly Balance[];
  readonly envelopes?: readonly EnvelopeBalance[];
  readonly lots?: readonly OpenLot[];
  readonly prices?: readonly Price[];
}

export const decodeAllocation: Decoder<Allocation> = versioned(
  object(
    { v: v1, date, envelope: envelopeId, amount: nonZeroInt, exp, cur: commodity },
    { idem: label, memo: nonEmptyString },
  ),
);

export const decodeRecon: Decoder<Recon> = versioned(
  object(
    {
      v: v1,
      account: accountId,
      statement_date: date,
      closing_balance: amount,
      cleared: arrayOf(msgId, { uniqueBy: (x) => x }),
    },
    { statement: blobRef, supersedes: msgId },
  ),
);

const PERIOD_RE = /^[0-9]{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/;

const head: Decoder<Head> = refine(
  object(
    { topic: refine(string, (t) => (t === 'budget' || segmentYear(t) !== undefined ? undefined : 'expected journal-YYYY or budget')), hash: msgId },
    { final: literal(true) },
  ),
  (h) => (h.final && h.topic === 'budget' ? '"final" is only for journal segments' : undefined),
);

export const decodeCheckpoint: Decoder<Checkpoint> = versioned(
  refine(
    object(
      {
        v: v1,
        period: refine(string, (p) => (PERIOD_RE.test(p) ? undefined : 'expected YYYY, YYYY-MM, or YYYY-Qn')),
        rounding: nonEmptyString,
        heads: arrayOf(head, { min: 1, uniqueBy: (h) => h.topic }),
      },
      {
        balances: arrayOf(object({ account: accountId, amount: int, exp, cur: commodity })),
        envelopes: arrayOf(object({ envelope: envelopeId, amount: int, exp, cur: commodity })),
        lots: arrayOf(
          object({
            lot: lotId, account: accountId, qty: posInt, exp, cur: commodity, basis: amount,
            acquired: date,
          }),
        ),
        prices: arrayOf(object({ commodity, date, price: amount })),
      },
    ),
    (c) =>
      (c.envelopes || c.lots || c.prices) && !c.balances
        ? 'a full checkpoint requires "balances"'
        : undefined,
  ),
);

// --- State documents ------------------------------------------------------------------

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface Account {
  readonly name: string;
  readonly type: AccountType;
  readonly cur: Commodity;
  readonly parent: AccountId | null;
  readonly closed_at?: IsoDate;
}

export interface AccountsDoc {
  readonly v: 1;
  readonly rev: number;
  readonly accounts: Readonly<Record<AccountId, Account>>;
}

/** The years that have a `journal-YYYY` segment, ascending. */
export interface JournalDoc {
  readonly v: 1;
  readonly rev: number;
  readonly years: readonly number[];
}

/** A monthly allocation from `from` until the next step, in the envelope's `cur`. */
export interface ScheduleStep {
  readonly from: Month;
  readonly amount: bigint;
  readonly exp: number;
}

export interface Envelope {
  readonly name: string;
  readonly cur: Commodity;
  readonly closed_at?: IsoDate;
  readonly schedule?: readonly ScheduleStep[];
}

export interface BudgetDoc {
  readonly v: 1;
  readonly rev: number;
  readonly envelopes: Readonly<Record<EnvelopeId, Envelope>>;
  /** Each expense account to the one envelope it is spent from. */
  readonly spent_from: Readonly<Record<AccountId, EnvelopeId>>;
  readonly budgetable: readonly AccountId[];
}

export interface Payee {
  readonly name: string;
  readonly merged_into?: PayeeId;
}

export interface PayeesDoc {
  readonly v: 1;
  readonly rev: number;
  readonly payees: Readonly<Record<PayeeId, Payee>>;
}

export const RULE_OPS = ['contains', 'prefix', 'equals'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export interface Rule {
  readonly id: RuleId;
  readonly op: RuleOp;
  readonly pattern: string;
  /** The text `pattern` is compared against. Absent means `description`. */
  readonly field?: 'description' | 'memo';
  /** Matches only rows whose amount, as posted to the account, has this sign. */
  readonly sign?: 'positive' | 'negative';
  readonly scope?: AccountId;
  readonly payee?: PayeeId;
  readonly account?: AccountId;
}

export interface RulesDoc {
  readonly v: 1;
  readonly rev: number;
  readonly rules: readonly Rule[];
}

export type Column = string | number;

/** WHATWG Encoding Standard canonical names a profile may name. */
export const PROFILE_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'] as const;
export type ProfileEncoding = (typeof PROFILE_ENCODINGS)[number];

export interface Profile {
  readonly delimiter: string;
  readonly decimal?: '.' | ',';
  readonly encoding?: ProfileEncoding;
  readonly skip_rows: number;
  readonly skip_end_rows?: number;
  readonly header: boolean;
  readonly date: { readonly column: Column; readonly format: string };
  readonly amount:
    | { readonly column: Column; readonly negate: boolean }
    | { readonly debit: Column; readonly credit: Column };
  readonly description: { readonly column: Column };
  readonly memo?: { readonly column: Column };
  readonly fitid?: { readonly column: Column };
  readonly pending?: { readonly column: Column; readonly value: string };
  readonly exp: number;
}

export interface ImportProfilesDoc {
  readonly v: 1;
  readonly rev: number;
  readonly profiles: Readonly<Record<AccountId, Profile>>;
}

const account: Decoder<Account> = object(
  {
    name: nonEmptyString,
    type: oneOf(ACCOUNT_TYPES),
    cur: commodity,
    parent: nullable(accountId),
  },
  { closed_at: date },
);

/** Shape only. The chart's cross-account rules are in chart.ts. */
export const decodeAccountsDoc: Decoder<AccountsDoc> = versioned(
  object({ v: v1, rev, accounts: record(isAccountId, account) }),
);

const year = refine(count, (n) => (n <= 9999 ? undefined : 'expected a year from 0 to 9999'));

export const decodeJournalDoc: Decoder<JournalDoc> = versioned(
  object({
    v: v1,
    rev,
    years: refine(arrayOf(year), (ys) =>
      ys.every((y, i) => i === 0 || ys[i - 1] < y) ? undefined : 'years must be strictly ascending',
    ),
  }),
);

const scheduleStep: Decoder<ScheduleStep> = object({ from: month, amount: int, exp });

const envelope: Decoder<Envelope> = object(
  { name: nonEmptyString, cur: commodity },
  {
    closed_at: date,
    schedule: refine(arrayOf(scheduleStep, { min: 1 }), (steps) =>
      steps.every((s, i) => i === 0 || steps[i - 1].from < s.from)
        ? undefined
        : 'steps must be sorted by "from" with no repeats',
    ),
  },
);

/**
 * Shape only. References to the chart, and from `spent_from` to `envelopes`, are checked
 * in budget.ts.
 */
export const decodeBudgetDoc: Decoder<BudgetDoc> = versioned(
  object({
    v: v1,
    rev,
    envelopes: record(isEnvelopeId, envelope),
    spent_from: record(isAccountId, envelopeId),
    budgetable: arrayOf(accountId, { uniqueBy: (x) => x }),
  }),
);

export const decodePayeesDoc: Decoder<PayeesDoc> = versioned(
  refine(
    object({
      v: v1,
      rev,
      payees: record(isPayeeId, object({ name: nonEmptyString }, { merged_into: payeeId })),
    }),
    (doc) => {
      const payees = doc.payees as Record<string, Payee>;
      for (const [id, p] of Object.entries(payees)) {
        if (p.merged_into === undefined) continue;
        const target = payees[p.merged_into];
        if (!target) return `${id} is merged into an unknown payee`;
        if (target.merged_into !== undefined) return `${id} is merged into a merged payee`;
      }
      return undefined;
    },
  ),
);

const rule: Decoder<Rule> = refine(
  object(
    {
      id: ruleId,
      op: oneOf(RULE_OPS),
      pattern: refine(nonEmptyString, (p) =>
        normalizeDescription(p) === p ? undefined : 'pattern must be stored normalized',
      ),
    },
    {
      field: oneOf(['description', 'memo'] as const),
      sign: oneOf(['positive', 'negative'] as const),
      scope: accountId,
      payee: payeeId,
      account: accountId,
    },
  ),
  (r) => (r.payee || r.account ? undefined : 'a rule sets at least one of "payee" and "account"'),
);

export const decodeRulesDoc: Decoder<RulesDoc> = versioned(
  object({ v: v1, rev, rules: arrayOf(rule, { uniqueBy: (r) => r.id }) }),
);

export const DATE_FORMAT_TOKEN = /YYYY|YY|MM|DD|M|D|[^A-Za-z0-9]/g;

/** `format` is built from `YYYY`, `YY`, `MM`, `DD`, `M`, `D`, and literal separators. */
function dateFormatProblem(format: string): string | undefined {
  const tokens = format.match(DATE_FORMAT_TOKEN) ?? [];
  if (tokens.join('') !== format) return 'unknown token in date format';
  const count = (xs: string[]) => tokens.filter((t) => xs.includes(t)).length;
  if (count(['YYYY', 'YY']) !== 1 || count(['MM', 'M']) !== 1 || count(['DD', 'D']) !== 1) {
    return 'date format needs exactly one year, month, and day';
  }
  return undefined;
}

function profileDecoder(header: boolean): Decoder<Profile> {
  const column: Decoder<Column> = header ? nonEmptyString : count;
  return object(
    {
      delimiter: refine(string, (d) =>
        [...d].length !== 1
          ? 'expected one character'
          : d === '"' || d === '\r' || d === '\n'
            ? 'the delimiter cannot be a quote or a line break'
            : undefined,
      ),
      skip_rows: count,
      header: literal(header),
      date: object({ column, format: refine(nonEmptyString, dateFormatProblem) }),
      amount: (v, path) =>
        isPlainObject(v) && Object.hasOwn(v, 'column')
          ? object({ column, negate: boolean })(v, path)
          : object({ debit: column, credit: column })(v, path),
      description: object({ column }),
      exp,
    },
    {
      decimal: oneOf(['.', ','] as const),
      encoding: oneOf(PROFILE_ENCODINGS),
      skip_end_rows: count,
      memo: object({ column }),
      fitid: object({ column }),
      pending: object({ column, value: string }),
    },
  );
}

/** One profile; whether `column`s are names or indices follows its `header`. */
export const decodeProfile: Decoder<Profile> = (v, path) => {
  const header = isPlainObject(v) ? v.header : undefined;
  return profileDecoder(boolean(header, path ? `${path}.header` : 'header'))(v, path);
};

export const decodeImportProfilesDoc: Decoder<ImportProfilesDoc> = versioned(
  object({ v: v1, rev, profiles: record(isAccountId, decodeProfile) }),
);

// --- Dispatch -------------------------------------------------------------------------

export interface MessageTypes {
  'ledger.entry': Entry;
  'ledger.reversal': Reversal;
  'ledger.edit': EditMessage;
  'ledger.dismiss': Dismiss;
  'ledger.lotadjust': LotAdjust;
  'ledger.allocation': Allocation;
  'ledger.recon': Recon;
  'ledger.checkpoint': Checkpoint;
}
export type MessageType = keyof MessageTypes;

export interface StateDocs {
  'ledger/accounts': AccountsDoc;
  'ledger/journal': JournalDoc;
  'ledger/budget': BudgetDoc;
  'ledger/payees': PayeesDoc;
  'ledger/rules': RulesDoc;
  'ledger/import-profiles': ImportProfilesDoc;
}
export type StatePath = keyof StateDocs;

const MESSAGE_DECODERS: { [T in MessageType]: Decoder<MessageTypes[T]> } = {
  'ledger.entry': decodeEntry,
  'ledger.reversal': decodeReversal,
  'ledger.edit': decodeEditMessage,
  'ledger.dismiss': decodeDismiss,
  'ledger.lotadjust': decodeLotAdjust,
  'ledger.allocation': decodeAllocation,
  'ledger.recon': decodeRecon,
  'ledger.checkpoint': decodeCheckpoint,
};

const STATE_DECODERS: { [P in StatePath]: Decoder<StateDocs[P]> } = {
  'ledger/accounts': decodeAccountsDoc,
  'ledger/journal': decodeJournalDoc,
  'ledger/budget': decodeBudgetDoc,
  'ledger/payees': decodePayeesDoc,
  'ledger/rules': decodeRulesDoc,
  'ledger/import-profiles': decodeImportProfilesDoc,
};

/** The message types each topic carries. */
export const TOPIC_TYPES = {
  journal: ['ledger.entry', 'ledger.reversal', 'ledger.edit', 'ledger.dismiss', 'ledger.lotadjust'],
  budget: ['ledger.allocation'],
  recon: ['ledger.recon'],
  checkpoints: ['ledger.checkpoint'],
} as const satisfies Record<string, readonly MessageType[]>;

export function isMessageType(type: string): type is MessageType {
  return Object.hasOwn(MESSAGE_DECODERS, type);
}

/**
 * Decodes a message's parsed `data`. Throws `UnknownTypeError` or `UnknownVersionError`
 * when the fold must stop, and `CodecError` when the message is malformed.
 */
export function decodeMessage<T extends MessageType>(type: T, data: unknown): MessageTypes[T];
export function decodeMessage(type: string, data: unknown): MessageTypes[MessageType];
export function decodeMessage(type: string, data: unknown): MessageTypes[MessageType] {
  if (!isMessageType(type)) throw new UnknownTypeError(type);
  return MESSAGE_DECODERS[type](data, '');
}

/** Parses and decodes a message's decrypted JSON text. */
export function parseMessage<T extends MessageType>(type: T, json: string): MessageTypes[T] {
  return decodeMessage(type, parseJson(json));
}

/**
 * Encodes a message for posting. The result is decoded again before it is returned, so
 * the client never posts a message it would itself reject as malformed.
 */
export function encodeMessage<T extends MessageType>(type: T, msg: MessageTypes[T]): string {
  decodeMessage(type, toWire(msg));
  return stringifyJson(msg);
}

export function isStatePath(path: string): path is StatePath {
  return Object.hasOwn(STATE_DECODERS, path);
}

export function decodeState<P extends StatePath>(path: P, data: unknown): StateDocs[P] {
  return STATE_DECODERS[path](data, '');
}

export function parseState<P extends StatePath>(path: P, json: string): StateDocs[P] {
  return decodeState(path, parseJson(json));
}

export function encodeState<P extends StatePath>(path: P, doc: StateDocs[P]): string {
  decodeState(path, toWire(doc));
  return stringifyJson(doc);
}
