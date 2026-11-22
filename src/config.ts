/**
 * Where the CLI points, and where it keeps things.
 *
 * @remarks
 * There is no single API host. In production each service has its own hostname, so the
 * endpoints are named individually. `--api` or `NXIS_API` collapses all of them onto one
 * base URL, which suits an environment that serves every service from the same origin.
 * The per-service variables (`NXIS_ACCOUNTS_URL`, `NXIS_BILLING_URL`,
 * `NXIS_AUTHORIZATION_URL`, `NXIS_MCP_URL`, `NXIS_SITES_URL`) override one service at a time.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { BUILD_CLIENT_ID } from "./build-config.js";
import { CliError } from "./errors.js";

/** Base URLs for each service the CLI talks to. */
export interface Endpoints {
  /** Accounts API: organizations and the accounts that own them. */
  accounts: string;
  /** Billing API: plans, subscriptions, quotas and credit packs. */
  billing: string;
  /** Authorization API: API keys. */
  authorization: string;
  /** Host that serves each organization's MCP endpoint. */
  mcp: string;
  /** Sites API: a site's hosted agent settings. */
  sites: string;
}

/**
 * Identity provider settings used for sign-in.
 *
 * @remarks
 * Named for the OIDC concepts rather than the provider, so that moving to another one does not
 * change the variables a build or a deployment sets.
 */
export interface AuthConfig {
  /** The identity provider's domain. */
  domain: string;
  /**
   * The CLI's Native application client id, with the Device Code grant enabled.
   *
   * @remarks
   * Embedded at build time; a non-empty `NXIS_AUTH_CLIENT_ID` at runtime overrides it. An
   * exported but empty variable is ignored, so it cannot erase the embedded id.
   */
  clientId: string;
  /**
   * The API audience requested for access tokens. The account-id custom claim is issued for
   * this audience, and every service validates against it.
   */
  audience: string;
}

/** The fully resolved configuration for one invocation. */
export interface Config {
  endpoints: Endpoints;
  auth: AuthConfig;
  /**
   * True only when no endpoint override of any kind is in effect.
   *
   * @remarks
   * When true, `mcp install` issues live keys; otherwise it issues development keys.
   */
  isProduction: boolean;
  /** Which profile produced this config, for display. */
  profile: string;
}

/** The production host for each service. */
export const PRODUCTION_ENDPOINTS: Endpoints = {
  accounts: "https://accounts.nxis.ai",
  billing: "https://subscriptions.nxis.ai",
  authorization: "https://authorization.nxis.ai",
  mcp: "https://mcp.nxis.ai",
  sites: "https://sites.nxis.ai",
};

/** The environment variable that overrides each service's base URL. */
export const ENDPOINT_ENV_VARS: Readonly<Record<keyof Endpoints, string>> = {
  accounts: "NXIS_ACCOUNTS_URL",
  billing: "NXIS_BILLING_URL",
  authorization: "NXIS_AUTHORIZATION_URL",
  mcp: "NXIS_MCP_URL",
  sites: "NXIS_SITES_URL",
};

/** The production identity provider domain. */
export const AUTH_DOMAIN = "nxis-ai.us.auth0.com";

/** The API audience that user access tokens are issued for. */
export const AUTH_AUDIENCE = "https://accounts.nxis.ai";

/**
 * The Native application's client id, embedded at build time.
 *
 * @remarks
 * Written from `NXIS_AUTH_CLIENT_ID` by `scripts/build-config.mjs`. It is a public
 * identifier, not a secret. It is empty in a build made without the variable; `nxis login`
 * then needs it at runtime, and `npm publish` refuses to run.
 */
export const AUTH_CLIENT_ID = BUILD_CLIENT_ID;

/**
 * Strips trailing slashes from a base URL.
 *
 * @param url - The base URL.
 * @returns The URL without trailing slashes.
 */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Treats an unset, empty or whitespace-only value as absent.
 *
 * @param value - A flag, environment variable or saved setting.
 * @returns The trimmed value, or undefined.
 */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Checks that a base URL is one, and says where a bad value came from.
 *
 * @remarks
 * Without this a value like `local` is accepted, saved, and only surfaces later as a failed
 * request against `local/v1alpha/...` — which points at the request rather than at the setting
 * that caused it, and gives no hint that a stale saved value is to blame.
 *
 * @param value - The candidate base URL.
 * @param source - Where it came from, named in the error so it can be corrected.
 * @returns The value unchanged.
 */
function requireUrl(value: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError(`${source} must be a URL, for example https://accounts.nxis.ai (got "${value}")`, {
      reason: "invalid_api_url",
      details: { source, value },
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`${source} must be an http or https URL (got "${value}")`, {
      reason: "invalid_api_url",
      details: { source, value },
    });
  }
  // Every request carries a bearer token, so plain http is only for this machine.
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new CliError(
      `${source} must use https unless it points at this machine (got "${value}"). ` +
        "A token sent over plain http can be read by anyone on the path.",
      { reason: "insecure_api_url", details: { source, value } },
    );
  }
  return value;
}

/** @returns True for a hostname that can only mean this machine. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** The `--api` value that clears a saved one and returns to production. */
export const PRODUCTION_API = "production";

/**
 * A stable name for the set of endpoints a configuration points at.
 *
 * @remarks
 * Stored with credentials, so a token is only ever sent to the services it was obtained for.
 * Without it, one `--api` pointed anywhere sent the stored token there on every later command.
 *
 * The sites endpoint came later, so it is named only when it is somewhere a setup would not put
 * it by itself: not the production sites host, and not the accounts host (which is where `--api`
 * puts it). Every sign-in made before it existed keeps its key, so nobody is signed out by an
 * upgrade; an explicit `NXIS_SITES_URL` pointing anywhere else still binds the sign-in to it.
 */
export function endpointKey(endpoints: Endpoints): string {
  const hosts = [endpoints.accounts, endpoints.billing, endpoints.authorization, endpoints.mcp];
  const usual = endpoints.sites === PRODUCTION_ENDPOINTS.sites || endpoints.sites === endpoints.accounts;
  return (usual ? hosts : [...hosts, endpoints.sites]).join(" ");
}

/**
 * Points every service at one base URL.
 *
 * @param base - The base URL; trailing slashes are removed.
 * @returns Endpoints that all share that base.
 */
export function singleHost(base: string): Endpoints {
  const trimmed = trimSlashes(base);
  return {
    accounts: trimmed,
    billing: trimmed,
    authorization: trimmed,
    mcp: trimmed,
    sites: trimmed,
  };
}

/**
 * The directory that holds the CLI's settings and file-based credentials.
 *
 * @returns `$XDG_CONFIG_HOME/nxis`, or `~/.config/nxis` when that is unset.
 */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "nxis") : join(homedir(), ".config", "nxis");
}

/** @returns The path of the credentials file used when no OS keychain is available. */
export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

/**
 * @returns The path of the file that holds provisioning keys when no OS keychain is available,
 * and the names of the keychain entries otherwise.
 */
export function provisioningKeysPath(): string {
  return join(configDir(), "provisioning-keys.json");
}

/** @returns The path of the saved settings file. */
export function settingsPath(): string {
  return join(configDir(), "config.json");
}

/**
 * Resolves where the CLI points for this invocation.
 *
 * @remarks
 * Each service resolves independently, most specific first: its per-service environment
 * variable, then the shared base URL (an explicit `--api`, then `NXIS_API`, then the saved
 * setting), then the production host. Trailing slashes are removed. Only base URLs change
 * between environments; no plan, price or pack is compiled in.
 *
 * @param opts - The `--api` and `--profile` flags, and previously saved settings.
 * @returns The resolved configuration.
 */
export function resolveConfig(opts: {
  api?: string;
  profile?: string;
  saved?: { api?: string; profile?: string };
}): Config {
  // `--api production` means "no base URL", whatever is saved.
  const reset = present(opts.api)?.toLowerCase() === PRODUCTION_API;
  const explicit = reset ? undefined : present(opts.api);
  const fromEnv = reset ? undefined : present(process.env.NXIS_API);
  const fromSaved = present(opts.saved?.api);

  const shared =
    (explicit !== undefined && requireUrl(explicit, "--api")) ||
    (fromEnv !== undefined && requireUrl(fromEnv, "NXIS_API")) ||
    (!reset && fromSaved !== undefined && requireUrl(fromSaved, `the saved --api setting in ${settingsPath()}`)) ||
    undefined;

  const fallback = shared ? singleHost(shared) : PRODUCTION_ENDPOINTS;

  let overridden = shared !== undefined;
  const endpoints = { ...fallback };
  for (const service of Object.keys(ENDPOINT_ENV_VARS) as Array<keyof Endpoints>) {
    const name = ENDPOINT_ENV_VARS[service];
    const specific = present(process.env[name]);
    if (specific) {
      overridden = true;
      endpoints[service] = trimSlashes(requireUrl(specific, name));
    }
  }

  const profile =
    opts.profile ??
    process.env.NXIS_PROFILE ??
    (reset ? undefined : opts.saved?.profile) ??
    (overridden ? "custom" : "production");

  return {
    endpoints,
    auth: {
      domain: process.env.NXIS_AUTH_DOMAIN ?? AUTH_DOMAIN,
      clientId: process.env.NXIS_AUTH_CLIENT_ID || AUTH_CLIENT_ID,
      audience: process.env.NXIS_AUTH_AUDIENCE ?? AUTH_AUDIENCE,
    },
    isProduction: !overridden,
    profile,
  };
}
