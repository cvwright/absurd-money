import { describe, expect, it } from 'vitest';
import { commodity, type Amount } from './amount.js';
import type { RawMessage } from './fold/segment.js';
import type { MsgId } from './ids.js';
import { decodeMessage, type Recon } from './messages.js';
import { clearedBalance, foldRecon, lastRecon, reconPostProblems, type ReconPostContext } from './recon.js';
import { A, chart, day, msg } from './testing.js';

const USD = commodity('USD');
const cents = (n: number): Amount => ({ amount: BigInt(n), exp: 2, cur: USD });

/** A wire `ledger.recon` of checking. */
const wire = (date: string, balance: number, cleared: MsgId[], extra: object = {}) => ({
  v: 1,
  account: A.checking,
  statement_date: date,
  closing_balance: { amount: String(balance), exp: 2, cur: 'USD' },
  cleared,
  ...extra,
});

const raw = (name: string, data: unknown, type = 'ledger.recon'): RawMessage => ({ id: msg(name), type, data });
const recon = (date: string, balance: number, cleared: MsgId[], extra: object = {}): Recon =>
  decodeMessage('ledger.recon', wire(date, balance, cleared, extra));

describe('foldRecon', () => {
  it('keeps valid recons and marks the superseded ones', () => {
    const fold = foldRecon([
      raw('aug', wire('2026-08-31', 1000, [msg('a')])),
      raw('sep', wire('2026-09-30', 1500, [msg('b')])),
      raw('sep2', wire('2026-09-30', 1700, [msg('b'), msg('c')], { supersedes: msg('sep') })),
    ], chart);
    expect(fold.anomalies).toEqual([]);
    expect(fold.recons.map((r) => [r.id, r.supersededBy])).toEqual([
      [msg('aug'), undefined],
      [msg('sep'), msg('sep2')],
      [msg('sep2'), undefined],
    ]);
  });

  it('ignores recons of nominal or unknown accounts, in the wrong commodity, or superseding badly', () => {
    const fold = foldRecon([
      raw('visa', wire('2026-08-31', 0, [], { account: A.visa })),
      raw('food', wire('2026-08-31', 0, [], { account: A.groceries })),
      raw('vti', wire('2026-08-31', 0, [], { account: A.vti })),
      raw('none', wire('2026-08-31', 0, [], { supersedes: msg('nowhere') })),
      raw('other', wire('2026-09-30', 0, [], { supersedes: msg('visa') })),
      raw('bad', { v: 1 }),
    ], chart);
    expect(fold.recons.map((r) => r.id)).toEqual([msg('visa')]);
    expect(fold.anomalies.map((a) => [a.msg, a.kind, a.detail])).toEqual([
      [msg('food'), 'invalid', "expense accounts can't be reconciled"],
      [msg('vti'), 'invalid', 'closing balance in USD on a VTI account'],
      [msg('none'), 'invalid', 'supersedes no earlier reconciliation'],
      [msg('other'), 'invalid', 'supersedes a reconciliation of another account'],
      [msg('bad'), 'malformed', expect.any(String)],
    ]);
  });

  it('reports a transaction cleared twice by standing recons', () => {
    const fold = foldRecon([
      raw('one', wire('2026-08-31', 1000, [msg('a')])),
      raw('two', wire('2026-09-30', 1000, [msg('a'), msg('b')])),
      raw('visa', wire('2026-09-30', 0, [msg('a')], { account: A.visa })),
    ], chart);
    expect(fold.anomalies).toEqual([
      { kind: 'cleared-twice', msg: msg('two'), detail: `${msg('a')} was already cleared by ${msg('one')}` },
    ]);
  });

  it('halts at an unknown type or version', () => {
    const fold = foldRecon([
      raw('one', wire('2026-08-31', 0, [])),
      raw('new', { ...wire('2026-09-30', 0, []), v: 2 }),
      raw('after', wire('2026-10-31', 0, [])),
    ], chart);
    expect(fold.halted?.at).toBe(msg('new'));
    expect(fold.recons.map((r) => r.id)).toEqual([msg('one')]);
  });
});

describe('reconPostProblems', () => {
  const ctx: ReconPostContext = {
    chart,
    recons: [{ id: msg('aug'), statementDate: day('2026-08-31'), cleared: [msg('open'), msg('pay')] }],
    postings: new Map([
      [msg('open'), cents(50000)],
      [msg('pay'), cents(100000)],
      [msg('food'), cents(-8423)],
      [msg('rent'), cents(-120000)],
    ]),
  };

  it('accepts a statement whose cleared balance matches', () => {
    expect(reconPostProblems(recon('2026-09-30', 141577, [msg('food')]), ctx)).toEqual([]);
    // A different exponent with the same value is the same balance.
    expect(reconPostProblems({ ...recon('2026-09-30', 0, [msg('food')]), closing_balance: { amount: 14157700n, exp: 4, cur: USD } }, ctx))
      .toEqual([]);
  });

  it('refuses a balance that does not match', () => {
    expect(reconPostProblems(recon('2026-09-30', 150000, [msg('food')]), ctx))
      .toEqual(['the cleared balance does not equal the closing balance']);
  });

  it('refuses transactions not on the account, already cleared, or a date not after the last', () => {
    expect(reconPostProblems(recon('2026-08-31', 0, [msg('pay'), msg('elsewhere')]), ctx)).toEqual([
      `${msg('pay')} was already cleared by ${msg('aug')}`,
      `${msg('elsewhere')} is not a transaction on this account`,
      'the statement date must be after the last reconciliation, on 2026-08-31',
    ]);
  });

  it('replaces a standing recon with one that supersedes it', () => {
    // Redo August without the paycheck: the opening balance alone.
    const redo = recon('2026-08-31', 50000, [msg('open')], { supersedes: msg('aug') });
    expect(reconPostProblems(redo, ctx)).toEqual([]);
    const done = { ...ctx, recons: [{ ...ctx.recons[0], supersededBy: msg('aug2') }] };
    expect(reconPostProblems(redo, done)).toEqual([
      `that reconciliation was already superseded by ${msg('aug2')}`,
    ]);
    expect(reconPostProblems(recon('2026-08-31', 0, [], { supersedes: msg('nope') }), ctx)).toEqual([
      "the superseded reconciliation is not one of this account's",
      'the statement date must be after the last reconciliation, on 2026-08-31',
    ]);
  });

  it('applies the fold-time rules', () => {
    expect(reconPostProblems({ ...recon('2026-09-30', 0, []), account: A.salary }, ctx))
      .toEqual(["income accounts can't be reconciled"]);
  });
});

describe('clearedBalance and lastRecon', () => {
  const ctx = {
    recons: [
      { id: msg('aug'), statementDate: day('2026-08-31'), cleared: [msg('a')] },
      { id: msg('old'), statementDate: day('2026-09-30'), cleared: [msg('b')], supersededBy: msg('sep') },
      { id: msg('sep'), statementDate: day('2026-09-30'), cleared: [msg('c'), msg('gone')] },
    ],
    postings: new Map([[msg('a'), cents(100)], [msg('b'), cents(20)], [msg('c'), cents(3)], [msg('d'), cents(4000)]]),
  };
  const zero = cents(0);

  it('sums the standing recons and the new cleared set, skipping what is not held', () => {
    expect(clearedBalance(ctx, zero, [msg('d')]).amount).toBe(4103n);
    expect(clearedBalance(ctx, zero, [msg('b')], msg('sep')).amount).toBe(120n);
  });

  it('finds the last standing recon', () => {
    expect(lastRecon(ctx.recons)?.id).toBe(msg('sep'));
    expect(lastRecon(ctx.recons, msg('sep'))?.id).toBe(msg('aug'));
  });
});
