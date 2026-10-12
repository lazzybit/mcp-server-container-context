import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessAssertionVerifier, AccessVerificationError } from "../../src/auth/access.js";
import { createRemoteJwksProvider } from "../../src/auth/jwks.js";
import {
  createJwtFixture,
  createKeyPair,
  noneAlgToken,
  verifierFor,
  type JwtFixture,
  type KeyPair,
} from "../helpers/jwt.js";

type TokenBuilder = (fixture: JwtFixture) => Promise<string>;

const rejectionCases: ReadonlyArray<readonly [string, TokenBuilder]> = [
  ["a malformed token", async () => "not-a-jwt"],
  ["an opaque oauth token", async () => "oauth:opaque-token-value"],
  ["a token with a bad signature", async () => (await createJwtFixture()).sign()],
  ["a token with the wrong issuer", async (f) => f.sign({ issuer: "https://evil.example.com" })],
  ["a token with the wrong audience", async (f) => f.sign({ audience: "other-aud" })],
  ["an expired token", async (f) => f.sign({ expiresInSeconds: -3600 })],
  ["a token missing exp", async (f) => f.sign({ expiresInSeconds: null })],
  ["a token with a non-numeric exp", async (f) => f.sign({ claims: { exp: "not-a-number" } })],
  ["a token whose nbf is in the future", async (f) => f.sign({ notBeforeOffsetSeconds: 3600 })],
  ["a token with an empty sub", async (f) => f.sign({ subject: "" })],
  ["a token missing sub", async (f) => f.sign({ subject: null })],
];

describe("AccessAssertionVerifier", () => {
  let fixture: JwtFixture;
  let verifier: AccessAssertionVerifier;

  beforeAll(async () => {
    fixture = await createJwtFixture();
    verifier = verifierFor(fixture);
  });

  it("accepts a valid assertion and derives the identity from iss + sub", async () => {
    const identity = await verifier.verify(await fixture.sign());
    expect(identity.issuer).toBe(fixture.issuer);
    expect(identity.subject).toBe("user-123");
    expect(identity.id).toBe(`${fixture.issuer}|user-123`);
  });

  it("accepts a token issued to a different subject", async () => {
    const identity = await verifier.verify(await fixture.sign({ subject: "other-user" }));
    expect(identity.subject).toBe("other-user");
  });

  it.each(rejectionCases)("rejects %s", async (_label, build) => {
    await expect(verifier.verify(await build(fixture))).rejects.toBeInstanceOf(AccessVerificationError);
  });

  it("rejects a token with alg: none", async () => {
    const token = noneAlgToken({
      iss: fixture.issuer,
      aud: fixture.audience,
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AccessVerificationError);
  });
});

async function signWith(key: KeyPair, issuer: string, audience: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: key.keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user-123")
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(key.privateKey);
}

describe("createRemoteJwksProvider (caching and rotation)", () => {
  let server: Server;
  let issuer: string;
  let keys: JWK[];
  let fetches = 0;
  let failNext = false;
  let keyA: KeyPair;
  let keyB: KeyPair;

  beforeAll(async () => {
    keyA = await createKeyPair("key-a");
    keyB = await createKeyPair("key-b");
    keys = [keyA.publicJwk];
    server = createServer((_req, res) => {
      fetches++;
      if (failNext) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    issuer = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("verifies from the cache without refetching and refreshes on an unknown kid", async () => {
    keys = [keyA.publicJwk];
    fetches = 0;
    failNext = false;

    const provider = createRemoteJwksProvider(issuer);
    const verifier = new AccessAssertionVerifier(issuer, "aud", provider);

    const tokenA = await signWith(keyA, issuer, "aud");
    await expect(verifier.verify(tokenA)).resolves.toBeDefined();
    expect(fetches).toBe(1);

    // A usable cached key set that contains the token's kid verifies with no fetch.
    await expect(verifier.verify(tokenA)).resolves.toBeDefined();
    expect(fetches).toBe(1);

    // Rotation: an unknown kid triggers a refresh.
    keys = [keyB.publicJwk];
    const tokenB = await signWith(keyB, issuer, "aud");
    await expect(verifier.verify(tokenB)).resolves.toBeDefined();
    expect(fetches).toBe(2);
  });

  it("rejects when the refresh fails", async () => {
    keys = [keyA.publicJwk];
    fetches = 0;
    failNext = false;

    const provider = createRemoteJwksProvider(issuer);
    const verifier = new AccessAssertionVerifier(issuer, "aud", provider);
    await verifier.verify(await signWith(keyA, issuer, "aud"));

    const rotated = await createKeyPair("key-c");
    failNext = true;
    await expect(verifier.verify(await signWith(rotated, issuer, "aud"))).rejects.toBeInstanceOf(
      AccessVerificationError,
    );
  });
});
