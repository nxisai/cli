/**
 * Getting a user token into the terminal.
 *
 * @remarks
 * Device flow is the default because it is the one that works where agents actually run:
 * containers, SSH sessions, cloud dev boxes. The agent relays a URL and a short code and
 * never touches a credential. `--web` is the loopback-PKCE alternative for someone sitting
 * at their own machine (RFC 8252).
 *
 * Both need an Auth0 Native application client id with the Device Code grant enabled. Without
 * one, login fails with a message saying so rather than an opaque Auth0 error.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { endpointKey, type Config } from "./config.js";
import { failed, needsUser, notAuthorized } from "./errors.js";
import { traceRequest, traceResponse } from "./trace.js";
import { plainText } from "./output.js";
import { openUrl } from "./browser.js";
import { loadCredentials, saveCredentials, type StoredCredentials } from "./credentials.js";
import { decodeJwt, isExpired } from "./tokens.js";

/**
 * The OAuth scopes requested at sign-in.
 *
 * @remarks
 * The services authorize by resource scope, not by role: ownership checks pass only when the
 * token's `scope` claim carries the matching `READ_OWN` or `WRITE_OWN` scope. Without these a
 * sign-in succeeds and `status` looks fine, because it reports rather than fails, but
 * `orgs list` fails with "Insufficient permissions to access resource".
 */
export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "WRITE_OWN:organization",
  "READ_OWN:account",
  "WRITE_OWN:account",
  "READ_OWN:organization",
  "READ_OWN:subscription",
].join(" ");

/** The response to a device authorization request. */
export interface DeviceCodeGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/** A token endpoint response. */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** An Auth0 error body. */
interface Auth0Error {
  error?: string;
  error_description?: string;
}

/**
 * Ensures a client id is available before contacting Auth0.
 *
 * @throws CliError `auth_client_missing` when none is configured.
 */
function assertClientConfigured(config: Config): void {
  if (!config.auth.clientId) {
    throw failed(
      "This build of the CLI has no OAuth client id, so it cannot sign in. Install the published " +
        "package, or set NXIS_AUTH_CLIENT_ID.",
      "auth_client_missing",
    );
  }
}

/**
 * Posts a form to an Auth0 endpoint.
 *
 * @remarks
 * On an error response, the Auth0 `error` code becomes the thrown error's `reason`, so callers
 * can tell "still waiting" from "failed".
 *
 * @throws CliError on a non-JSON or error response.
 */
async function postForm<T>(url: string, form: Record<string, string>): Promise<T> {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  // Traced but never withheld by --dry-run: without a token every later command would report
  // being signed out, which would say nothing about what the command itself would have done.
  traceRequest({ method: "POST", url, headers, form });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
  });
  traceResponse(res.status, url);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw failed(`Auth0 returned a non-JSON response from ${url}`, "auth_bad_response");
  }
  if (!res.ok) {
    const err = (parsed ?? {}) as Auth0Error;
    const e = failed(plainText(err.error_description ?? err.error ?? `HTTP ${res.status}`), err.error ?? "auth_error");
    (e.details as Record<string, unknown>)["provider_error"] = err.error ?? null;
    throw e;
  }
  return parsed as T;
}

/** Starts the device flow. */
export async function requestDeviceCode(config: Config): Promise<DeviceCodeGrant> {
  assertClientConfigured(config);
  return postForm<DeviceCodeGrant>(`https://${config.auth.domain}/oauth/device/code`, {
    client_id: config.auth.clientId,
    scope: SCOPES,
    audience: config.auth.audience,
  });
}

/**
 * Poll until the person finishes in the browser.
 *
 * @remarks
 * `authorization_pending` is the normal state for most of this loop, and `slow_down` is
 * Auth0 telling us to back off — treating either as an error would abort a sign-in that
 * is going fine.
 *
 * @param signal - Stops waiting: the person said no where they were asked.
 * @throws CliError `cancelled` (exit 2) once the signal aborts.
 */
export async function pollForDeviceToken(
  config: Config,
  grant: DeviceCodeGrant,
  onTick?: (elapsedMs: number) => void,
  signal?: AbortSignal,
): Promise<StoredCredentials> {
  const started = Date.now();
  let intervalMs = (grant.interval ?? 5) * 1000;
  const deadline = started + grant.expires_in * 1000;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    if (signal?.aborted) throw needsUser("Stopped waiting for the sign-in.", "cancelled");
    if (Date.now() > deadline) {
      throw needsUser(
        "The sign-in code expired before it was confirmed. Run `nxis login` again.",
        "device_code_expired",
      );
    }

    try {
      const token = await postForm<TokenResponse>(`https://${config.auth.domain}/oauth/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: grant.device_code,
        client_id: config.auth.clientId,
      });
      return toCredentials(token, config);
    } catch (err) {
      const reason = (err as { reason?: string }).reason ?? "";
      if (reason === "authorization_pending") {
        onTick?.(Date.now() - started);
        continue;
      }
      if (reason === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (reason === "expired_token") {
        throw needsUser(
          "The sign-in code expired before it was confirmed. Run `nxis login` again.",
          "device_code_expired",
        );
      }
      if (reason === "access_denied") {
        // Auth0 says why: the person cancelled, an Action refused them, or the application may
        // not request this API. Without the description every one of these reads as a cancel.
        const said = (err as Error).message;
        const description = said && said !== "access_denied" ? said : undefined;
        throw notAuthorized(
          description ? `Sign-in was declined: ${description}` : "Sign-in was declined in the browser.",
          "access_denied",
          description ? { provider_description: description } : {},
        );
      }
      throw err;
    }
  }
}

/** Loopback PKCE, for `--web`. */
export async function loginViaBrowser(config: Config): Promise<StoredCredentials> {
  assertClientConfigured(config);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  return new Promise<StoredCredentials>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      // Only the identity provider's redirect counts: the callback path, carrying this sign-in's
      // state. Anything else on this port — another local process, a page probing it — is
      // turned away without ending or affecting the sign-in, including a request carrying
      // `error`, which would otherwise cancel it.
      if (url.pathname !== "/callback" || returnedState !== state) {
        res.writeHead(404).end();
        return;
      }

      const finish = (message: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>NxisAI</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1 style="font-size:1.25rem">${message}</h1>
<p style="color:#555">You can close this tab and return to your terminal.</p></body>`);
      };

      if (error) {
        finish("Sign-in failed.");
        server.close();
        reject(notAuthorized(plainText(url.searchParams.get("error_description") ?? error), "access_denied"));
        return;
      }
      if (!code) {
        res.writeHead(400).end();
        return;
      }

      finish("You're signed in.");
      server.close();

      const port = (server.address() as AddressInfo).port;
      postForm<TokenResponse>(`https://${config.auth.domain}/oauth/token`, {
        grant_type: "authorization_code",
        client_id: config.auth.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
      })
        .then((token) => resolve(toCredentials(token, config)))
        .catch(reject);
    });

    server.on("error", (err) => reject(failed(`Could not start a local callback server: ${err.message}`, "loopback_failed")));

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const authorizeUrl =
        `https://${config.auth.domain}/authorize?` +
        new URLSearchParams({
          response_type: "code",
          client_id: config.auth.clientId,
          redirect_uri: `http://127.0.0.1:${port}/callback`,
          scope: SCOPES,
          audience: config.auth.audience,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString();

      process.stderr.write(`Opening your browser to sign in.\nIf it doesn't open: ${authorizeUrl}\n`);
      openUrl(authorizeUrl);
    });
  });
}

/**
 * Exchanges a refresh token for new credentials.
 *
 * @remarks
 * Auth0 omits the refresh token when rotation is off; the existing one is kept in that case.
 */
export async function refreshAccessToken(
  config: Config,
  refreshToken: string,
): Promise<StoredCredentials> {
  assertClientConfigured(config);
  const token = await postForm<TokenResponse>(`https://${config.auth.domain}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: config.auth.clientId,
    refresh_token: refreshToken,
  });
  return toCredentials(token, config, refreshToken);
}

/** Converts a token response into stored credentials, bound to the endpoints in use. */
function toCredentials(token: TokenResponse, config: Config, fallbackRefresh?: string): StoredCredentials {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? fallbackRefresh,
    expiresAt: token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined,
    profile: config.profile,
    endpoints: endpointKey(config.endpoints),
  };
}

/**
 * Whether stored credentials may be sent to the configured endpoints.
 *
 * @remarks
 * Only to the endpoints they were obtained for. Credentials saved before the binding existed
 * carry none, and are accepted by production alone, which is the only place they could have
 * come from without an override.
 */
export function credentialsMatch(creds: StoredCredentials, config: Config): boolean {
  if (creds.endpoints === undefined) return config.isProduction;
  return creds.endpoints === endpointKey(config.endpoints);
}

/**
 * A usable access token, refreshed silently if it has expired.
 *
 * @remarks
 * NXIS_TOKEN wins and is never refreshed or written — it is supplied deliberately by
 * someone who wants exactly that token used. Stored credentials are only used against the
 * endpoints they were obtained for.
 *
 * @throws CliError `environment_mismatch` (exit 3) when the stored credentials belong to
 * other endpoints.
 */
export async function getAccessToken(config: Config): Promise<string> {
  const creds = loadCredentials();
  if (!creds) {
    throw notAuthorized("You are not signed in. Run `nxis login`.", "signed_out");
  }
  if (creds.profile === "env") return creds.accessToken;

  if (!credentialsMatch(creds, config)) {
    throw notAuthorized(
      `You are signed in to a different NxisAI environment than ${config.endpoints.accounts}. ` +
        "Run `nxis login` to sign in to this one, or `--api production` to go back.",
      "environment_mismatch",
      { api: config.endpoints.accounts },
    );
  }

  if (!isExpired(decodeJwt(creds.accessToken))) return creds.accessToken;

  if (!creds.refreshToken) {
    throw notAuthorized("Your session expired. Run `nxis login`.", "session_expired");
  }
  const refreshed = await refreshAccessToken(config, creds.refreshToken);
  saveCredentials(refreshed);
  return refreshed.accessToken;
}

/** The token if there is one, without throwing — for `status`, which reports rather than fails. */
export async function tryGetAccessToken(config: Config): Promise<string | null> {
  try {
    return await getAccessToken(config);
  } catch {
    return null;
  }
}
