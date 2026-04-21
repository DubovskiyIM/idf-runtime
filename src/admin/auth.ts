import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_SECONDS = 5 * 60;

export function createAdminAuth(secret: string) {
  return (req: Request & { rawBody?: string }, res: Response, next: NextFunction) => {
    const ts = Number(req.get('x-idf-ts') ?? '0');
    const sig = req.get('x-idf-sig') ?? '';
    const body = req.rawBody ?? (req.method === 'GET' ? '' : JSON.stringify(req.body));
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return res.status(401).json({ error: 'stale_ts' });

    const expected = createHmac('sha256', secret)
      .update(`${req.method.toUpperCase()}\n${req.originalUrl}\n${body}\n${ts}`)
      .digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    next();
  };
}
