import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/**
 * A JWKS key resolver. The verifier takes one of these so tests can inject a
 * local fixture; production constructs the remote provider from
 * `TEAM_DOMAIN`. There is no configuration path that disables verification.
 */
export type JwksProvider = JWTVerifyGetKey;

/**
 * Build a cached remote JWKS resolver for a Cloudflare Access team. The URL is
 * fixed by configuration and never taken from the presented token. `jose`
 * caches the key set, matches by `kid`, and refreshes once on an unknown
 * `kid`; a failed refresh rejects.
 */
export function createRemoteJwksProvider(issuer: string): JwksProvider {
  return createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    // An unknown `kid` must trigger exactly one refresh so a rotated Access key
    // is picked up immediately; jose's default cooldown would otherwise reject
    // a fresh, valid key until the cooldown window elapsed.
    cooldownDuration: 0,
  });
}
