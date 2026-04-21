import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_SECONDS = 5 * 60;

function canonical(body: string, ts: number): string {
  return `POST\n/admin/reload\n${body}\n${ts}`;
}

export function signDomain(secret: string, body: string, ts: number): string {
  return createHmac('sha256', secret).update(canonical(body, ts)).digest('hex');
}

export function verifyDomainSignature(
  secret: string,
  body: string,
  ts: number,
  providedSig: string,
  nowSec: number
): boolean {
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) return false;
  const expected = signDomain(secret, body, ts);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(providedSig, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
