// Test vectors from design/LABELS.md.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import type { AccountId, EnvelopeId, Month } from './ids.js';
import {
  allocationLabel, deriveLabelKeys, importLabel, nsKeyForTests, priceLabel, rawLabelForTests,
  reconSessionLabel, type Namespace,
} from './labels.js';

const root = Uint8Array.from({ length: 32 }, (_, i) => i);
const spaceId = 'SCAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_';
const keys = deriveLabelKeys(root, spaceId);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const acct = 'acct_7bQ2xV9mKd4TnR1sYgLp';

describe('keys', () => {
  it('label_key', () => {
    expect(hex(hkdf(sha256, root, undefined, `label key | ${spaceId}`, 32))).toBe(
      '5fb3eda6ed20a93d548cca9ff8410987371b01e78406fb0db033c7fdb97b6df3',
    );
  });
  it.each([
    ['import/v1', '8ea3bcf9afd938215bd73b4a997a1d7557a00f416af1c91aeda8c8dae5a3d41e'],
    ['allocation/v1', '4f0c34fc41b64a12dfcb96fdca7979e5f958cfff8a3ef0a544694a6cd1e8304d'],
    ['recon-session/v1', 'edf04786b2ce89ae92a2dd4eb1aa40a14434d2e0dfa0ccf7688c1e55739f4ce5'],
    ['price/v1', 'aff2528ca6505a361e0ecbe78d28861faa28c553eec0d3ecabc1a48f663fa7ed'],
  ] as const)('ns_key(%s)', (ns, key) => expect(hex(nsKeyForTests(keys, ns))).toBe(key));
});

describe('labels', () => {
  it.each([
    ['import/v1', `${acct}|2026-09-14|-5|blue bottle|#0`, 'fHzNwT_vazZtt4ZD4_ds'],
    ['import/v1', `${acct}|2026-09-14|-5|blue bottle|#1`, '0DYOhH_pvRLqCs6SE27n'],
    ['import/v1', `${acct}|2026-09-14|12.34|refund | acme|#0`, 'gx_aYWRrEd5juPUrfdtc'],
    ['import/v1', `${acct}|2026-09-14|-5|οδος 5|#0`, '4008RCU-g26W_5n99gdy'],
    ['import/v1', `${acct}|fitid|20260914-ABc01`, 'zDD51zVCRVeQmz1JmTl_'],
    ['import/v1', '', 'T-Yt1sI50YSb1UzDrq8a'],
    ['price/v1', acct, 'OQ4A9jOUebqw-6vnNwGA'],
  ] as const)('%s %j', (ns, s, out) => expect(rawLabelForTests(keys, ns as Namespace, s)).toBe(out));

  it('per-namespace functions', () => {
    expect(importLabel(keys, `${acct}|fitid|20260914-ABc01`)).toBe('zDD51zVCRVeQmz1JmTl_');
    expect(allocationLabel(keys, 'env_Lm3vT8cHq2NbXr5kYwPd' as EnvelopeId, '2025-12' as Month)).toBe('8st65e_c184_Zs3jseMu');
    expect(reconSessionLabel(keys, acct as AccountId)).toBe('NmrMaf0goLBM2KEhE6wr');
    expect(priceLabel(keys, 'VTI', 2026)).toBe('Cp6QVP1dMUlu8bhe0WHD');
  });

  it('rejects lone surrogates and bad inputs', () => {
    expect(() => importLabel(keys, '\uD800')).toThrow(RangeError);
    expect(() => priceLabel(keys, 'vti', 2026)).toThrow(RangeError);
    expect(() => allocationLabel(keys, 'env_Lm3vT8cHq2NbXr5kYwPd' as EnvelopeId, '2025-13' as Month)).toThrow(RangeError);
    expect(() => allocationLabel(keys, acct as unknown as EnvelopeId, '2025-12' as Month)).toThrow(RangeError);
    expect(() => deriveLabelKeys(root.subarray(1), spaceId)).toThrow(RangeError);
  });
});
