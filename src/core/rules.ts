/**
 * Import rules (`ledger/rules` in design/SCHEMAS.md): matching a row, choosing its payee
 * and category, and the rules for rewriting the document (0021).
 *
 * Rules suggest; they never post. Review shows what they chose, and the user approves.
 * The payee and the category are chosen separately: each comes from the first rule in
 * order that matches the row and sets a usable one, so a rule that names only a payee
 * doesn't stop a later rule from choosing the category.
 */

import type { Decimal } from './amount.js';
import type { Chart } from './chart.js';
import type { AccountId, PayeeId, RuleId } from './ids.js';
import type { PayeesDoc, Rule, RulesDoc } from './messages.js';
import { normalizeDescription } from './normalize.js';
import { payeeOf, resolvePayee } from './payees.js';

/**
 * The rule list before its first write. Its `rev` is 0, so the first write is rev 1. It
 * is never written itself.
 */
export const EMPTY_RULES: RulesDoc = { v: 1, rev: 0, rules: [] };

/** What a rule is matched against: one row of a statement and the account it goes into. */
export interface RuleSubject {
  readonly account: AccountId;
  /** Signed as posted to `account`. */
  readonly amount: Decimal;
  /** The raw cells. They are normalized here. */
  readonly description: string;
  readonly memo?: string;
}

/** What the rules chose for a row, and which rule chose each. */
export interface Categorization {
  readonly payee?: PayeeId;
  readonly payeeRule?: RuleId;
  readonly account?: AccountId;
  readonly accountRule?: RuleId;
}

/** Text as a rule pattern is stored: the `import/v1` normalization. */
export const rulePattern = normalizeDescription;

/** Whether `rule` matches `row`. Its references aren't checked here; see `categorize`. */
export function ruleMatches(rule: Rule, row: RuleSubject): boolean {
  if (rule.scope !== undefined && rule.scope !== row.account) return false;
  if (rule.sign === 'positive' && row.amount.amount <= 0n) return false;
  if (rule.sign === 'negative' && row.amount.amount >= 0n) return false;
  const text = normalizeDescription((rule.field === 'memo' ? row.memo : row.description) ?? '');
  // The decoder guarantees the pattern is normalized and non-empty.
  switch (rule.op) {
    case 'contains':
      return text.includes(rule.pattern);
    case 'prefix':
      return text.startsWith(rule.pattern);
    case 'equals':
      return text === rule.pattern;
  }
}

/** Why `rule`'s category can't be used for a row in `into`, or `undefined` if it can. */
function categoryProblem(chart: Chart, category: AccountId, into: AccountId | undefined): string | undefined {
  const a = chart.get(category);
  if (!a) return 'unknown account';
  if (a.closed_at !== undefined) return 'account is closed';
  if (category === into) return 'account is the one being imported into';
  const target = into === undefined ? undefined : chart.get(into);
  if (target && target.cur !== a.cur) return `account holds ${a.cur}, not ${target.cur}`;
  return undefined;
}

function payeeProblem(payees: PayeesDoc | undefined, payee: PayeeId): string | undefined {
  return payeeOf(payees, payee) ? undefined : 'unknown payee';
}

/**
 * The payee and category the rules choose for `row`, or neither. A rule's payee follows
 * its merge. A reference that is no longer usable (an unknown or closed account, one in
 * another commodity, the account being imported into, or an unknown payee) is passed
 * over, and a later rule may choose instead.
 */
export function categorize(
  doc: RulesDoc | undefined,
  row: RuleSubject,
  ctx: { chart: Chart; payees: PayeesDoc | undefined },
): Categorization {
  let payee: { payee: PayeeId; payeeRule: RuleId } | undefined;
  let account: { account: AccountId; accountRule: RuleId } | undefined;
  for (const rule of doc?.rules ?? []) {
    if (payee && account) break;
    if ((!rule.payee || payee) && (!rule.account || account)) continue;
    if (!ruleMatches(rule, row)) continue;
    if (!payee && rule.payee && payeeProblem(ctx.payees, rule.payee) === undefined) {
      payee = { payee: resolvePayee(ctx.payees, rule.payee), payeeRule: rule.id };
    }
    if (!account && rule.account && categoryProblem(ctx.chart, rule.account, row.account) === undefined) {
      account = { account: rule.account, accountRule: rule.id };
    }
  }
  return { ...payee, ...account };
}

/**
 * The rule's references that can't be used for any row, to surface. A category can still
 * be unusable for a particular row (see `categorize`).
 */
export function ruleRefProblems(rule: Rule, ctx: { chart: Chart; payees: PayeesDoc | undefined }): string[] {
  const problems: string[] = [];
  if (rule.scope !== undefined) {
    const t = ctx.chart.get(rule.scope)?.type;
    if (t === undefined) problems.push(`${rule.id}: scope: unknown account`);
    else if (t !== 'asset' && t !== 'liability') problems.push(`${rule.id}: scope: not an asset or liability account`);
  }
  if (rule.account !== undefined) {
    const p = categoryProblem(ctx.chart, rule.account, rule.scope);
    if (p) problems.push(`${rule.id}: ${p}`);
  }
  if (rule.payee !== undefined) {
    const p = payeeProblem(ctx.payees, rule.payee);
    if (p) problems.push(`${rule.id}: ${p}`);
  }
  return problems;
}

/**
 * `doc` with `rule` added, or replacing the rule with its ID. It goes at `index`, or else
 * where the rule it replaces was, or else last. Its pattern is normalized here. Throws if
 * the pattern is blank or the rule sets neither a payee nor a category.
 */
export function withRule(doc: RulesDoc, rule: Rule, index?: number): RulesDoc {
  const pattern = rulePattern(rule.pattern);
  if (pattern === '') throw new Error('a rule needs a pattern');
  if (!rule.payee && !rule.account) throw new Error('a rule sets a payee, a category, or both');
  const at = doc.rules.findIndex((r) => r.id === rule.id);
  const rules = doc.rules.filter((r) => r.id !== rule.id);
  rules.splice(index ?? (at === -1 ? rules.length : at), 0, { ...rule, pattern });
  return { ...doc, rules };
}

/** `doc` without the rule `id`. The same document if there is none. */
export function withoutRule(doc: RulesDoc, id: RuleId): RulesDoc {
  return doc.rules.some((r) => r.id === id) ? { ...doc, rules: doc.rules.filter((r) => r.id !== id) } : doc;
}

function sameRule(a: Rule, b: Rule): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Rule>;
  return [...keys].every((k) => a[k] === b[k]);
}

/**
 * Post-time rules for replacing `prev` with `next`, against the current chart and payee
 * list: `rev` goes up by one, and every rule that is new or changed passes
 * `ruleRefProblems` and names no payee that was merged away. A rule left unchanged is not
 * checked again, so an account closed since it was written doesn't block every later
 * write. Rules may be removed and reordered.
 */
export function rulesUpdateProblems(
  prev: RulesDoc,
  next: RulesDoc,
  ctx: { chart: Chart; payees: PayeesDoc | undefined },
): string[] {
  const problems: string[] = [];
  if (next.rev !== prev.rev + 1) problems.push(`rev must be ${prev.rev + 1}`);
  const before = new Map(prev.rules.map((r) => [r.id, r]));
  for (const rule of next.rules) {
    const old = before.get(rule.id);
    if (old && sameRule(old, rule)) continue;
    problems.push(...ruleRefProblems(rule, ctx));
    if (rule.payee && payeeOf(ctx.payees, rule.payee)?.merged_into !== undefined) {
      problems.push(`${rule.id}: payee was merged away`);
    }
  }
  return problems;
}
