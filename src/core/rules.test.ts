import { describe, expect, it } from 'vitest';
import type { Decimal } from './amount.js';
import type { PayeeId, RuleId } from './ids.js';
import { decodePayeesDoc, decodeRulesDoc, encodeState, type Rule } from './messages.js';
import {
  categorize, EMPTY_RULES, ruleMatches, ruleRefProblems, rulesUpdateProblems, withoutRule, withRule,
  type RuleSubject,
} from './rules.js';
import { A, chart } from './testing.js';

const p = (name: string) => `payee_${name.padEnd(20, 'x')}` as PayeeId;
const r = (name: string) => `rule_${name.padEnd(20, 'x')}` as RuleId;
const cents = (n: number): Decimal => ({ amount: BigInt(n), exp: 2 });

const payees = decodePayeesDoc(
  {
    v: 1,
    rev: 2,
    payees: {
      [p('bb')]: { name: 'Blue Bottle' },
      [p('bb2')]: { name: 'Blue Bottle Coffee', merged_into: p('bb') },
      [p('amzn')]: { name: 'Amazon' },
    },
  },
  '',
);
const ctx = { chart, payees };

const row = (description: string, extra: Partial<RuleSubject> = {}): RuleSubject => ({
  account: A.visa,
  amount: cents(-450),
  description,
  ...extra,
});

const rule = (id: string, pattern: string, extra: Partial<Rule> = {}): Rule => ({
  id: r(id),
  op: 'contains',
  pattern,
  ...extra,
});

const doc = (...rules: Rule[]) => decodeRulesDoc({ v: 1, rev: 1, rules }, '');

describe('ruleMatches', () => {
  it('compares the normalized description', () => {
    const subject = row('  SQ *BLUE   BOTTLE 0412 ');
    expect(ruleMatches(rule('a', 'blue bottle'), subject)).toBe(true);
    expect(ruleMatches(rule('a', 'sq *blue', { op: 'prefix' }), subject)).toBe(true);
    expect(ruleMatches(rule('a', 'blue bottle', { op: 'prefix' }), subject)).toBe(false);
    expect(ruleMatches(rule('a', 'sq *blue bottle 0412', { op: 'equals' }), subject)).toBe(true);
    expect(ruleMatches(rule('a', 'sq *blue bottle', { op: 'equals' }), subject)).toBe(false);
  });

  it('compares the memo when asked, and a missing memo matches nothing', () => {
    const subject = row('POS PURCHASE', { memo: 'Blue Bottle Oakland' });
    expect(ruleMatches(rule('a', 'blue bottle', { field: 'memo' }), subject)).toBe(true);
    expect(ruleMatches(rule('a', 'blue bottle'), subject)).toBe(false);
    expect(ruleMatches(rule('a', 'pos purchase', { field: 'description' }), subject)).toBe(true);
    expect(ruleMatches(rule('a', 'pos', { field: 'memo' }), row('POS PURCHASE'))).toBe(false);
  });

  it('honors scope and sign', () => {
    const zelle = rule('a', 'zelle', { scope: A.checking, sign: 'positive' });
    expect(ruleMatches(zelle, row('ZELLE FROM SAM', { account: A.checking, amount: cents(5000) }))).toBe(true);
    expect(ruleMatches(zelle, row('ZELLE TO SAM', { account: A.checking, amount: cents(-5000) }))).toBe(false);
    expect(ruleMatches(zelle, row('ZELLE FROM SAM', { account: A.visa, amount: cents(5000) }))).toBe(false);
    expect(ruleMatches(rule('a', 'zelle', { sign: 'negative' }), row('ZELLE TO SAM'))).toBe(true);
  });
});

describe('categorize', () => {
  it('takes the payee and the category each from the first rule that sets one', () => {
    const rules = doc(
      rule('payee', 'blue bottle', { payee: p('bb') }),
      rule('cat', 'bottle', { account: A.dining }),
      rule('late', 'blue', { payee: p('amzn'), account: A.groceries }),
    );
    expect(categorize(rules, row('BLUE BOTTLE'), ctx)).toEqual({
      payee: p('bb'), payeeRule: r('payee'), account: A.dining, accountRule: r('cat'),
    });
    expect(categorize(rules, row('BLUE SKY'), ctx)).toEqual({
      payee: p('amzn'), payeeRule: r('late'), account: A.groceries, accountRule: r('late'),
    });
    expect(categorize(rules, row('CORNER STORE'), ctx)).toEqual({});
    expect(categorize(undefined, row('BLUE BOTTLE'), ctx)).toEqual({});
    expect(categorize(EMPTY_RULES, row('BLUE BOTTLE'), ctx)).toEqual({});
  });

  it('follows a payee merge', () => {
    const rules = doc(rule('a', 'blue bottle', { payee: p('bb2') }));
    expect(categorize(rules, row('BLUE BOTTLE'), ctx).payee).toBe(p('bb'));
  });

  it('passes over references it cannot use, so a later rule chooses', () => {
    const fallback = rule('z', 'x', { payee: p('amzn'), account: A.groceries });
    const cases: [Rule, string][] = [
      [rule('a', 'x', { account: A.rent }), 'closed'],
      [rule('a', 'x', { account: A.vti }), 'another commodity'],
      [rule('a', 'x', { account: A.visa }), 'the account imported into'],
      [rule('a', 'x', { account: `acct_${'n'.repeat(20)}` as never }), 'unknown account'],
    ];
    for (const [bad, why] of cases) {
      expect(categorize(doc(bad, fallback), row('X'), ctx).account, why).toBe(A.groceries);
    }
    const unknownPayee = rule('a', 'x', { payee: p('gone'), account: A.dining });
    expect(categorize(doc(unknownPayee, fallback), row('X'), ctx)).toEqual({
      payee: p('amzn'), payeeRule: r('z'), account: A.dining, accountRule: r('a'),
    });
  });
});

describe('editing', () => {
  it('adds, replaces in place, moves, and removes', () => {
    const one = withRule(EMPTY_RULES, rule('a', '  Blue\tBottle ', { payee: p('bb') }));
    expect(one.rules[0].pattern).toBe('blue bottle');
    const two = withRule(one, rule('b', 'amazon', { payee: p('amzn') }));
    expect(two.rules.map((x) => x.id)).toEqual([r('a'), r('b')]);
    const edited = withRule(two, rule('a', 'blue bottle', { account: A.dining }));
    expect(edited.rules.map((x) => x.id)).toEqual([r('a'), r('b')]);
    expect(edited.rules[0]).toEqual(rule('a', 'blue bottle', { account: A.dining }));
    const moved = withRule(edited, edited.rules[1], 0);
    expect(moved.rules.map((x) => x.id)).toEqual([r('b'), r('a')]);
    expect(withoutRule(moved, r('b')).rules.map((x) => x.id)).toEqual([r('a')]);
    expect(withoutRule(moved, r('nope'))).toBe(moved);
    expect(() => encodeState('ledger/rules', { ...moved, rev: 1 })).not.toThrow();
  });

  it('refuses a blank pattern or a rule that sets nothing', () => {
    expect(() => withRule(EMPTY_RULES, rule('a', ' \t', { payee: p('bb') }))).toThrow(/pattern/);
    expect(() => withRule(EMPTY_RULES, rule('a', 'x'))).toThrow(/payee/);
  });
});

describe('ruleRefProblems', () => {
  it('checks the scope, category, and payee', () => {
    expect(ruleRefProblems(rule('a', 'x', { scope: A.checking, account: A.dining, payee: p('bb') }), ctx)).toEqual([]);
    expect(ruleRefProblems(rule('a', 'x', { scope: A.dining, account: A.groceries }), ctx)).toEqual([
      `${r('a')}: scope: not an asset or liability account`,
    ]);
    expect(ruleRefProblems(rule('a', 'x', { scope: A.checking, account: A.checking }), ctx)).toEqual([
      `${r('a')}: account is the one being imported into`,
    ]);
    expect(ruleRefProblems(rule('a', 'x', { scope: A.checking, account: A.vti }), ctx)).toEqual([
      `${r('a')}: account holds VTI, not USD`,
    ]);
    expect(ruleRefProblems(rule('a', 'x', { account: A.vti }), ctx)).toEqual([]);
    expect(ruleRefProblems(rule('a', 'x', { payee: p('gone') }), ctx)).toEqual([`${r('a')}: unknown payee`]);
  });
});

describe('rulesUpdateProblems', () => {
  const prev = doc(rule('old', 'rent', { account: A.rent }));

  it('needs the next rev and checks only new or changed rules', () => {
    const add = { ...withRule(prev, rule('new', 'amazon', { payee: p('amzn') })), rev: 2 };
    expect(rulesUpdateProblems(prev, add, ctx)).toEqual([]);
    expect(rulesUpdateProblems(prev, { ...add, rev: 3 }, ctx)).toEqual(['rev must be 2']);
    const changed = { ...withRule(prev, rule('old', 'rent payment', { account: A.rent })), rev: 2 };
    expect(rulesUpdateProblems(prev, changed, ctx)).toEqual([`${r('old')}: account is closed`]);
  });

  it('allows removing rules but not naming a payee merged away', () => {
    expect(rulesUpdateProblems(prev, { ...withoutRule(prev, r('old')), rev: 2 }, ctx)).toEqual([]);
    const merged = { ...withRule(prev, rule('new', 'bb', { payee: p('bb2') })), rev: 2 };
    expect(rulesUpdateProblems(prev, merged, ctx)).toEqual([`${r('new')}: payee was merged away`]);
  });
});
