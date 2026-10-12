import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

import { AccessAssertionVerifier } from "../../src/auth/access.js";
import type { JwksProvider } from "../../src/auth/jwks.js";

export const DEFAULT_TEST_ISSUER = "https://team.example.com";
export const DEFAULT_TEST_AUDIENCE = "test-aud-tag";

export interface SignOverrides {
  issuer?: string;
  audience?: string;
  /** `null` omits the `sub` claim entirely. */
  subject?: string | null;
  /** `null` omits the `exp` claim entirely. */
  expiresInSeconds?: number | null;
  /** Set a positive number to put `nbf` in the future. */
  notBeforeOffsetSeconds?: number;
  keyId?: string;
  key?: CryptoKey;
  /** Extra or overriding claims merged into the payload last. */
  claims?: Record<string, unknown>;
}

export interface JwtFixture {
  readonly issuer: string;
  readonly audience: string;
  readonly provider: JwksProvider;
  readonly publicJwk: JWK;
  readonly privateKey: CryptoKey;
  readonly keyId: string;
  sign(overrides?: SignOverrides): Promise<string>;
}

export interface KeyPair {
  readonly publicJwk: JWK;
  readonly privateKey: CryptoKey;
  readonly keyId: string;
}

/** Generate an RSA key pair suitable for RS256 assertions. */
export async function createKeyPair(keyId = "test-key-1"): Promise<KeyPair> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = keyId;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { publicJwk, privateKey, keyId };
}

/** A JWKS provider backed by a local, non-rotating key set. */
export function providerFor(keys: JWK[]): JwksProvider {
  return createLocalJWKSet({ keys }) as unknown as JwksProvider;
}

export async function createJwtFixture(
  issuer: string = DEFAULT_TEST_ISSUER,
  audience: string = DEFAULT_TEST_AUDIENCE,
): Promise<JwtFixture> {
  const keyPair = await createKeyPair();
  const provider = providerFor([keyPair.publicJwk]);

  const sign = async (overrides: SignOverrides = {}): Promise<string> => {
    const resolvedIssuer = overrides.issuer ?? issuer;
    const resolvedAudience = overrides.audience ?? audience;
    const payload: Record<string, unknown> = {};
    if (resolvedIssuer.length > 0) {
      payload["iss"] = resolvedIssuer;
    }
    if (resolvedAudience.length > 0) {
      payload["aud"] = resolvedAudience;
    }
    if (overrides.subject !== null) {
      payload["sub"] = overrides.subject ?? "user-123";
    }
    const expiresInSeconds = overrides.expiresInSeconds === undefined ? 3600 : overrides.expiresInSeconds;
    if (expiresInSeconds !== null) {
      payload["exp"] = Math.floor(Date.now() / 1000) + expiresInSeconds;
    }
    if (overrides.notBeforeOffsetSeconds !== undefined) {
      payload["nbf"] = Math.floor(Date.now() / 1000) + overrides.notBeforeOffsetSeconds;
    }
    // Explicit claims win, so tests can produce malformed values like a string exp.
    Object.assign(payload, overrides.claims ?? {});

    const jwt = new SignJWT(payload).setProtectedHeader({
      alg: "RS256",
      kid: overrides.keyId ?? keyPair.keyId,
      typ: "JWT",
    });
    return jwt.sign(overrides.key ?? keyPair.privateKey);
  };

  return {
    issuer,
    audience,
    provider,
    publicJwk: keyPair.publicJwk,
    privateKey: keyPair.privateKey,
    keyId: keyPair.keyId,
    sign,
  };
}

/** Build a verifier wired to the fixture's local provider. */
export function verifierFor(fixture: JwtFixture, issuer?: string, audience?: string): AccessAssertionVerifier {
  return new AccessAssertionVerifier(issuer ?? fixture.issuer, audience ?? fixture.audience, fixture.provider);
}

/** A signed token with `alg: none`, used to assert the verifier refuses it. */
export function noneAlgToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}
