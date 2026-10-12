import { jwtVerify } from "jose";

import type { Config } from "../config.js";
import { createRemoteJwksProvider, type JwksProvider } from "./jwks.js";

/** Small tolerance for clock skew when checking `exp`. */
const CLOCK_TOLERANCE_SECONDS = 5;

export interface AccessIdentity {
  /** Token issuer (team domain URL). */
  readonly issuer: string;
  /** Token subject. */
  readonly subject: string;
  /** Email claim when present. */
  readonly email?: string;
  /** Stable session identity: `issuer|subject`. */
  readonly id: string;
}

export class AccessVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccessVerificationError";
  }
}

/**
 * Verifies a Cloudflare Access assertion (`Cf-Access-Jwt-Assertion`).
 *
 * Required claims: `iss` equal to the configured issuer, `aud` containing the
 * configured AUD tag, a numeric `exp` in the future, and a non-empty `sub`.
 * Any failure to complete verification — missing, malformed, bad signature,
 * unusable algorithm, wrong issuer/audience, missing/invalid `exp` — is a
 * rejection (fail closed).
 */
export class AccessAssertionVerifier {
  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly jwks: JwksProvider,
  ) {}

  static fromConfig(config: Config): AccessAssertionVerifier {
    return new AccessAssertionVerifier(
      config.issuer,
      config.applicationAud,
      createRemoteJwksProvider(config.issuer),
    );
  }

  async verify(assertion: string): Promise<AccessIdentity> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(assertion, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      payload = result.payload as Record<string, unknown>;
    } catch (error) {
      throw new AccessVerificationError("access assertion rejected", { cause: error });
    }

    const subject = payload["sub"];
    if (typeof subject !== "string" || subject.length === 0) {
      throw new AccessVerificationError("access assertion is missing a non-empty sub claim");
    }

    const exp = payload["exp"];
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new AccessVerificationError("access assertion is missing a numeric exp claim");
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (exp <= nowSeconds - CLOCK_TOLERANCE_SECONDS) {
      throw new AccessVerificationError("access assertion is expired");
    }

    const email = payload["email"];
    return {
      issuer: this.issuer,
      subject,
      ...(typeof email === "string" && email.length > 0 ? { email } : {}),
      id: `${this.issuer}|${subject}`,
    };
  }
}
