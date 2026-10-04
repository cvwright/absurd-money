import { describe, expect, it } from 'vitest';
import type { PayeeId } from './ids.js';
import { decodePayeesDoc, encodeState } from './messages.js';
import {
  cleanPayeeName, EMPTY_PAYEES, findPayee, payeeChoices, payeeName, payeesUpdateProblems, resolvePayee, withPayee,
} from './payees.js';

const p = (name: string) => `payee_${name.padEnd(20, 'x')}` as PayeeId;

/** Blue Bottle, with a duplicate merged into it, and Amazon. */
const doc = decodePayeesDoc(
  {
    v: 1,
    rev: 3,
    payees: {
      [p('bb')]: { name: 'Blue Bottle Coffee' },
      [p('bb2')]: { name: 'Blue Bottle', merged_into: p('bb') },
      [p('amzn')]: { name: 'Amazon' },
    },
  },
  '',
);

describe('lookup', () => {
  it('follows a merge for the ID and the name', () => {
    expect(resolvePayee(doc, p('bb2'))).toBe(p('bb'));
    expect(resolvePayee(doc, p('amzn'))).toBe(p('amzn'));
    expect(payeeName(doc, p('bb2'))).toBe('Blue Bottle Coffee');
    expect(payeeName(doc, p('nope'))).toBe('');
    expect(payeeName(undefined, p('bb'))).toBe('');
  });

  it('finds a payee by name, ignoring case and spacing, through merges', () => {
    expect(findPayee(doc, '  AMAZON ')).toBe(p('amzn'));
    expect(findPayee(doc, 'blue   bottle coffee')).toBe(p('bb'));
    expect(findPayee(doc, 'Blue Bottle')).toBe(p('bb'));
    expect(findPayee(doc, 'Blue')).toBeUndefined();
    expect(findPayee(doc, '   ')).toBeUndefined();
    expect(findPayee(undefined, 'Amazon')).toBeUndefined();
  });

  it('picks the same payee on every client when names collide', () => {
    const twins = decodePayeesDoc(
      { v: 1, rev: 1, payees: { [p('z')]: { name: 'Shop' }, [p('a')]: { name: 'shop' }, [p('b')]: { name: 'Other' } } },
      '',
    );
    expect(findPayee(twins, 'SHOP')).toBe(p('a'));
    // A payee not merged away wins over a merged one with a lower ID.
    const merged = decodePayeesDoc(
      { v: 1, rev: 1, payees: { [p('a')]: { name: 'Shop', merged_into: p('b') }, [p('b')]: { name: 'Other' }, [p('c')]: { name: 'Shop' } } },
      '',
    );
    expect(findPayee(merged, 'Shop')).toBe(p('c'));
  });

  it('offers the payees not merged away, by name', () => {
    expect(payeeChoices(doc)).toEqual([
      { id: p('amzn'), name: 'Amazon' },
      { id: p('bb'), name: 'Blue Bottle Coffee' },
    ]);
    expect(payeeChoices(undefined)).toEqual([]);
  });
});

describe('withPayee', () => {
  it('adds a payee with its name cleaned', () => {
    const next = withPayee(EMPTY_PAYEES, p('new'), '  Corner\tStore ');
    expect(next.payees[p('new')]).toEqual({ name: 'Corner Store' });
    expect(cleanPayeeName(' a  b ')).toBe('a b');
    expect(() => encodeState('ledger/payees', { ...next, rev: 1 })).not.toThrow();
  });

  it('refuses a taken ID or a blank name', () => {
    expect(() => withPayee(doc, p('amzn'), 'Amazon again')).toThrow(/already exists/);
    expect(() => withPayee(doc, p('new'), ' ')).toThrow(/name/);
  });
});

describe('payeesUpdateProblems', () => {
  it('needs the next rev and never removes a payee', () => {
    expect(payeesUpdateProblems(doc, { ...withPayee(doc, p('new'), 'New'), rev: 4 })).toEqual([]);
    expect(payeesUpdateProblems(doc, { ...doc, rev: 3 })).toEqual(['rev must be 4']);
    const { [p('amzn')]: _, ...rest } = doc.payees;
    expect(payeesUpdateProblems(doc, { ...doc, rev: 4, payees: rest })).toEqual([`${p('amzn')}: payees are never removed`]);
  });
});
