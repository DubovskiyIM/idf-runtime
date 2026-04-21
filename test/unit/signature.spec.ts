import { describe, it, expect } from 'vitest';
import { signDomain, verifyDomainSignature } from '../../src/domain/signature.js';

const SECRET = 'a'.repeat(64);

describe('domain signature', () => {
  it('roundtrip', () => {
    const body = JSON.stringify({ entities: {}, intents: {} });
    const ts = 1700000000;
    const sig = signDomain(SECRET, body, ts);
    expect(verifyDomainSignature(SECRET, body, ts, sig, ts + 60)).toBe(true);
  });

  it('rejects wrong secret', () => {
    const body = '{}';
    const ts = 1700000000;
    const sig = signDomain(SECRET, body, ts);
    expect(verifyDomainSignature('b'.repeat(64), body, ts, sig, ts + 60)).toBe(false);
  });

  it('rejects stale timestamp', () => {
    const body = '{}';
    const ts = 1700000000;
    const sig = signDomain(SECRET, body, ts);
    expect(verifyDomainSignature(SECRET, body, ts, sig, ts + 10 * 60)).toBe(false);
  });
});
