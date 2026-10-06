import { describe, expect, it } from 'vitest';
import { CodecError } from './errors.js';
import {
  draftProfile, EMPTY_PROFILES, guessDraft, guessEncoding, profileDraft, profilesUpdateProblems, relabelWarnings,
  withProfile,
} from './import-profiles.js';
import type { Profile } from './messages.js';
import { A, chart } from './testing.js';

const profile: Profile = {
  delimiter: ',',
  skip_rows: 0,
  header: true,
  date: { column: 'Date', format: 'MM/DD/YYYY' },
  amount: { column: 'Amount', negate: false },
  description: { column: 'Description' },
  exp: 2,
};
const doc1 = withProfile({ ...EMPTY_PROFILES, rev: 1 }, A.checking, profile);
const next = (p: Profile, account = A.checking) => withProfile({ ...doc1, rev: 2 }, account, p);

describe('profilesUpdateProblems', () => {
  it('accepts a first profile and a change to one', () => {
    expect(profilesUpdateProblems(EMPTY_PROFILES, doc1, chart)).toEqual([]);
    expect(profilesUpdateProblems(doc1, next({ ...profile, exp: 3 }), chart)).toEqual([]);
  });

  it('refuses a bad rev, a removed profile, and a change of scheme', () => {
    expect(profilesUpdateProblems(doc1, doc1, chart)).toEqual(['rev must be 2']);
    expect(profilesUpdateProblems(doc1, { ...EMPTY_PROFILES, rev: 2 }, chart))
      .toEqual([`${A.checking}: profiles are never removed`]);
    expect(profilesUpdateProblems(doc1, next({ ...profile, fitid: { column: 'Id' } }), chart))
      .toEqual([`${A.checking}: a profile never changes its import ID scheme`]);
  });

  it('only allows open asset and liability accounts', () => {
    expect(profilesUpdateProblems(doc1, next(profile, A.visa), chart)).toEqual([]);
    expect(profilesUpdateProblems(doc1, next(profile, A.dining), chart))
      .toEqual([`${A.dining}: not an asset or liability account`]);
    expect(profilesUpdateProblems(doc1, next(profile, A.rent), chart)).toEqual([`${A.rent}: account is closed`]);
  });

  it('does not check an unchanged profile again', () => {
    const closed = new Map(chart).set(A.checking, { ...chart.get(A.checking)!, closed_at: '2026-01-01' as never });
    expect(profilesUpdateProblems(doc1, next(profile, A.visa), closed)).toEqual([]);
  });
});

describe('relabelWarnings', () => {
  it('names the changes that move labels', () => {
    expect(relabelWarnings(profile, { ...profile, exp: 3, date: { column: 'Date', format: 'M/D/YYYY' } })).toEqual([]);
    expect(relabelWarnings(profile, { ...profile, description: { column: 'Memo' }, encoding: 'windows-1252' }))
      .toEqual(['the description column changed', 'the encoding changed']);
    const fitid = { ...profile, fitid: { column: 'Id' } };
    expect(relabelWarnings(fitid, { ...fitid, description: { column: 'Memo' } })).toEqual([]);
  });
});

describe('drafts', () => {
  it('round-trips a profile', () => {
    const full: Profile = {
      ...profile,
      delimiter: '\t',
      decimal: ',',
      encoding: 'windows-1252',
      skip_rows: 2,
      skip_end_rows: 1,
      amount: { debit: 'Out', credit: 'In' },
      memo: { column: 'Memo' },
      pending: { column: 'Status', value: 'Pending' },
    };
    expect(draftProfile(profileDraft(full))).toEqual(full);
    expect(draftProfile(profileDraft(profile))).toEqual(profile);
  });

  it('reads columns as indices without a header, and rejects a bad draft', () => {
    const d = { ...profileDraft(profile), header: false, date: '0', amount: '2', description: '1' };
    expect(draftProfile(d)).toMatchObject({ date: { column: 0 }, amount: { column: 2 }, description: { column: 1 } });
    expect(() => draftProfile({ ...profileDraft(profile), description: '' })).toThrow(CodecError);
    expect(() => draftProfile({ ...profileDraft(profile), dateFormat: 'MM/DD' })).toThrow(CodecError);
  });

  it('guesses a draft from a file', () => {
    const csv = 'Posting Date;Description;Debit;Credit;Memo\n09/14/2026;BLUE BOTTLE;5,00;;card\n10/01/2026;PAY;;2500,00;\n';
    expect(guessDraft(new TextEncoder().encode(csv), 2)).toMatchObject({
      encoding: 'utf-8', delimiter: ';', header: true, date: 'Posting Date', dateFormat: 'MM/DD/YYYY',
      amountMode: 'split', debit: 'Debit', credit: 'Credit', description: 'Description', memo: 'Memo', exp: 2,
    });
  });

  it('suggests an encoding without guessing at import time', () => {
    expect(guessEncoding(new TextEncoder().encode('Café'))).toBe('utf-8');
    expect(guessEncoding(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe('windows-1252');
    expect(guessEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe('utf-16le');
  });
});
