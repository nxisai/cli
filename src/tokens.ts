/**
 * Reading an access token without verifying it.
 *
 * @remarks
 * The CLI never validates signatures — the services do that, and a client that trusts its
 * own verification learns nothing. All we want locally is the account id and the expiry,
 * so we can pick the right organization and refresh before a call fails.
 *
 * The account id lives in an Auth0 custom claim added at sign-in. The claim is nested three
 * deep and the id is itself an object, so the path is `<namespace>.account._id.value`. Older
 * accounts carry the claim under a legacy namespace, which is read as a fallback.
 */

/** Custom-claim namespaces that may carry the account, current one first. */
export const CLAIM_NAMESPACES = ["https://nxis.ai/user_data", "https://codified.dev/user_data"] as const;

/** The JWT payload fields the CLI reads. */
export interface JwtPayload {
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  azp?: string;
  gty?: string;
  scope?: string;
  [claim: string]: unknown;
}

/** Decode the payload of a JWT. Returns null for anything that isn't one. */
export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * The account id from the user_data claim, or null when it has not been added yet.
 *
 * @remarks
 * Null is a meaningful answer, not an error: on a brand-new signup the claim can be absent
 * on the very first token, which is why the login command refreshes once before giving up.
 */
export function accountIdFromClaims(payload: JwtPayload | null): string | null {
  if (!payload) return null;
  for (const ns of CLAIM_NAMESPACES) {
    const data = payload[ns];
    if (!data || typeof data !== "object") continue;
    const account = (data as Record<string, unknown>)["account"];
    if (!account || typeof account !== "object") continue;
    const id = (account as Record<string, unknown>)["_id"];
    if (!id || typeof id !== "object") continue;
    const value = (id as Record<string, unknown>)["value"];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Email, when the token carries one. Display only. */
export function emailFromClaims(payload: JwtPayload | null): string | null {
  if (!payload) return null;
  const direct = payload["email"];
  if (typeof direct === "string") return direct;
  for (const ns of CLAIM_NAMESPACES) {
    const data = payload[ns];
    if (!data || typeof data !== "object") continue;
    const account = (data as Record<string, unknown>)["account"];
    if (!account || typeof account !== "object") continue;
    const profile = (account as Record<string, unknown>)["profile"];
    if (profile && typeof profile === "object") {
      const email = (profile as Record<string, unknown>)["email"];
      if (typeof email === "string") return email;
    }
  }
  return null;
}

/**
 * Expired, or close enough that a call made now might land after expiry.
 *
 * @remarks
 * The 60s skew means we refresh slightly early rather than serve one doomed request.
 */
export function isExpired(payload: JwtPayload | null, skewSeconds = 60): boolean {
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
}
