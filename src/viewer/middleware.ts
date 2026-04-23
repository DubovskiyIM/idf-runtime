import type { Request, Response, NextFunction } from 'express';
import type { ViewerClaims } from './jwt.js';

declare module 'express-serve-static-core' {
  interface Request {
    viewer?: {
      userId: string;
      role: string;
      domainSlug: string;
    };
  }
}

export type RevocationChecker = (userId: string, domainSlug: string) => boolean;

export function createViewerMiddleware(
  verify: (token: string) => Promise<ViewerClaims>,
  tenantSlug: string,
  isRevoked: RevocationChecker
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.get('authorization') ?? '';
    // M1.2: cookie flow. Iframe'ы tenant'а в studio не могут set Bearer,
    // поэтому читаем JWT cookie `idf_jwt` если Bearer отсутствует. Требует
    // cookieParser middleware выше в chain'е и cookie Domain=.intent-design.tech
    // при set (идентити plane + studio).
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.idf_jwt;
    const token = bearer || cookieToken || '';
    if (!token) return res.status(401).json({ error: 'no_token' });

    try {
      const claims = await verify(token);
      const m = claims.memberships.find(x => x.domainSlug === tenantSlug);
      if (!m) return res.status(403).json({ error: 'no_membership' });
      if (isRevoked(claims.sub, tenantSlug)) return res.status(403).json({ error: 'revoked' });

      req.viewer = { userId: claims.sub, role: m.role, domainSlug: tenantSlug };
      next();
    } catch (e: any) {
      res.status(401).json({ error: 'invalid_token', details: e?.message });
    }
  };
}
