import { createRemoteJWKSet, jwtVerify } from 'jose';

export type ViewerClaims = {
  sub: string;
  memberships: Array<{ domainSlug: string; role: string }>;
  iat: number;
  exp: number;
};

export function createJwtVerifier(jwksUrl: string) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 60 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });

  return async (token: string): Promise<ViewerClaims> => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'auth.idf.dev',
      algorithms: ['RS256'],
    });
    return payload as unknown as ViewerClaims;
  };
}
