/**
 * Where tokens live.
 *
 * @remarks
 * The OS keychain when there is one, a 0600 file when there isn't. Both are reached through
 * command-line tools already present on the platform rather than a native module, because a
 * native dependency would mean a compile step on `npx -y @nxisai/cli` — the one thing that
 * has to stay instant for an agent invoking this cold.
 *
 * Tokens are never printed. Not in `--json`, not in errors, not in verbose output. The only
 * secret this CLI ever surfaces is the MCP key, once, as a preview.
 *
 * Two kinds of secret live here: the sign-in tokens, in one entry named `default`, and the
 * provisioning keys the CLI mints for its own MCP calls, one entry per environment and
 * organization. They are kept apart so signing in again never disturbs a key, and a key being
 * refused never disturbs the session.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { credentialsPath, provisioningKeysPath } from "./config.js";
import type { KeyEnv } from "./api/apikeys.js";
import { writePrivateFile } from "./files.js";

const KEYCHAIN_SERVICE = "nxis-cli";
const KEYCHAIN_ACCOUNT = "default";

/** Tokens as stored between invocations. */
export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch seconds. Advisory — the token's own `exp` is authoritative. */
  expiresAt?: number;
  /** Which profile was in use at sign-in, for display. `env` marks a token from `NXIS_TOKEN`. */
  profile?: string;
  /**
   * The endpoints these were obtained for, as `endpointKey` names them. The token is never sent
   * anywhere else. Absent on credentials saved before this existed, which only production accepts.
   */
  endpoints?: string;
}

/** Runs a command synchronously; never throws. */
function run(cmd: string, args: string[], input?: string): { ok: boolean; stdout: string } {
  try {
    const res = spawnSync(cmd, args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return { ok: res.status === 0, stdout: res.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** @returns True when the command is on the PATH. */
function hasCommand(cmd: string): boolean {
  return run(process.platform === "win32" ? "where" : "which", [cmd]).ok;
}

/** macOS `security`, Linux `secret-tool`. Windows falls through to the file. */
function keychainKind(): "security" | "secret-tool" | null {
  if (process.env.NXIS_NO_KEYCHAIN === "1") return null;
  if (process.platform === "darwin" && hasCommand("security")) return "security";
  if (process.platform === "linux" && hasCommand("secret-tool")) return "secret-tool";
  return null;
}

/**
 * The longest line `security -i` reads whole. It truncates longer lines silently, which would
 * store damaged credentials, so a longer payload is never written that way.
 */
const INTERACTIVE_LINE_MAX = 4000;

/**
 * The `security -i` command that stores a payload, hex-encoded.
 *
 * @remarks
 * Hex because the command is parsed by `security` itself, and hex needs no quoting.
 */
export function keychainAddCommand(service: string, account: string, payload: string): string {
  return `add-generic-password -U -s ${service} -a ${account} -X ${Buffer.from(payload, "utf8").toString("hex")}\n`;
}

/**
 * Stores the payload in the OS keychain.
 *
 * @remarks
 * On macOS the payload goes to `security -i` on stdin, so the tokens never appear in a process's
 * arguments, where `ps` shows them to every user on the machine. `-U` updates an existing entry in
 * place. The entry is read back to confirm it; only if that fails, or the payload is too long for
 * `security -i`, is it passed with `-w` on argv as before, because the alternative is a file.
 * `secret-tool` already reads it from stdin.
 *
 * @returns True when the keychain accepted it.
 */
function keychainWrite(payload: string, account: string = KEYCHAIN_ACCOUNT): boolean {
  const kind = keychainKind();
  if (kind === "security") {
    const line = keychainAddCommand(KEYCHAIN_SERVICE, account, payload);
    if (line.length <= INTERACTIVE_LINE_MAX && run("security", ["-i"], line).ok && keychainRead(account) === payload) {
      return true;
    }
    return run("security", [
      "add-generic-password",
      "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w", payload,
    ]).ok;
  }
  if (kind === "secret-tool") {
    return run("secret-tool", [
      "store",
      "--label=NxisAI CLI",
      "service", KEYCHAIN_SERVICE,
      "account", account,
    ], payload).ok;
  }
  return false;
}

/** @returns The stored payload, or null when there is none or no keychain. */
function keychainRead(account: string = KEYCHAIN_ACCOUNT): string | null {
  const kind = keychainKind();
  if (kind === "security") {
    const res = run("security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w",
    ]);
    return res.ok && res.stdout.trim() ? res.stdout.trim() : null;
  }
  if (kind === "secret-tool") {
    const res = run("secret-tool", [
      "lookup",
      "service", KEYCHAIN_SERVICE,
      "account", account,
    ]);
    return res.ok && res.stdout.trim() ? res.stdout.trim() : null;
  }
  return null;
}

/** Removes the keychain entry, if any. */
function keychainClear(account: string = KEYCHAIN_ACCOUNT): void {
  const kind = keychainKind();
  if (kind === "security") {
    run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  } else if (kind === "secret-tool") {
    run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account]);
  }
}

/** Writes the payload to the credentials file with mode 0600. */
function fileWrite(payload: string): void {
  writePrivateFile(credentialsPath(), payload, { privateDir: true });
}

/** @returns The credentials file's contents, or null when it does not exist. */
function fileRead(): string | null {
  try {
    return readFileSync(credentialsPath(), "utf8");
  } catch {
    return null;
  }
}

/**
 * Credentials from `NXIS_TOKEN`, when set.
 *
 * @remarks
 * The token bypasses storage entirely: it is used, never written, and never refreshed. It is
 * meant for automation and debugging, not as a way around signing in.
 */
export function envToken(): StoredCredentials | null {
  const token = process.env.NXIS_TOKEN;
  if (!token) return null;
  return { accessToken: token, profile: "env" };
}

/** Stores credentials in the keychain, or the credentials file when there is no keychain. */
export function saveCredentials(creds: StoredCredentials): void {
  const payload = JSON.stringify(creds);
  if (!keychainWrite(payload)) fileWrite(payload);
}

/** @returns Credentials from `NXIS_TOKEN`, the keychain or the file, in that order; or null. */
export function loadCredentials(): StoredCredentials | null {
  const fromEnv = envToken();
  if (fromEnv) return fromEnv;

  const raw = keychainRead() ?? fileRead();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const creds = parsed as StoredCredentials;
    return typeof creds.accessToken === "string" ? creds : null;
  } catch {
    return null;
  }
}

/**
 * Removes stored credentials from the keychain and the credentials file.
 *
 * @remarks
 * A missing or unremovable file is ignored.
 */
export function clearCredentials(): void {
  keychainClear();
  try {
    rmSync(credentialsPath());
  } catch {
    return;
  }
}

/**
 * A provisioning key as stored between invocations.
 *
 * @remarks
 * The key is minted by the CLI for its own calls to the provisioning MCP endpoint, which accepts
 * an API key and refuses a sign-in token. It is bound to the endpoints and the organization it was
 * minted for, like the session is, so it is never sent anywhere else.
 */
export interface StoredProvisioningKey {
  /** The raw key. Never printed; {@link preview} it instead. */
  apiKey: string;
  /** The service's id for the key, so it can be revoked later. Empty when the service sent none. */
  keyId: string;
  /** The service's own preview of the key, for display. */
  preview: string;
  /** The organization the key belongs to. */
  orgId: string;
  /** The endpoints the key was minted against, as `endpointKey` names them. */
  endpoints: string;
  /** `live` in production, `dev` elsewhere. */
  env: KeyEnv;
  /** Epoch seconds. */
  createdAt: number;
}

/** The fallback file: keys when there is no keychain, and the keychain entries' names when there is. */
interface ProvisioningKeyFile {
  keys: Record<string, StoredProvisioningKey>;
  keychain: string[];
}

/** Characters `security -i` reads without quoting, and that every keychain accepts in a name. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** @returns The first 12 hex characters of the value's SHA-256. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * The keychain account that holds the provisioning key for one environment and organization.
 *
 * @remarks
 * `provisioning:<environment>:<organization>`, under the same `nxis-cli` service as the tokens.
 * The environment is a short hash of its endpoints rather than the endpoints themselves: they are
 * four URLs separated by spaces, and the name is passed unquoted to `security -i`. An organization
 * id outside the safe characters is hashed for the same reason. The `default` entry, which holds
 * the tokens, can never collide with this.
 *
 * @param endpoints - The endpoints, as `endpointKey` names them.
 * @param orgId - The organization.
 */
export function provisioningKeyAccount(endpoints: string, orgId: string): string {
  const org = SAFE_NAME.test(orgId) ? orgId : shortHash(orgId);
  return `provisioning:${shortHash(endpoints)}:${org}`;
}

/** @returns The fallback file's contents, or an empty one when it is missing or unreadable. */
function readKeyFile(): ProvisioningKeyFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(provisioningKeysPath(), "utf8"));
    const obj = parsed && typeof parsed === "object" ? (parsed as Partial<ProvisioningKeyFile>) : {};
    return {
      keys: obj.keys && typeof obj.keys === "object" ? obj.keys : {},
      keychain: Array.isArray(obj.keychain) ? obj.keychain.filter((n) => typeof n === "string") : [],
    };
  } catch {
    return { keys: {}, keychain: [] };
  }
}

/** Writes the fallback file with mode 0600. */
function writeKeyFile(file: ProvisioningKeyFile): void {
  writePrivateFile(provisioningKeysPath(), `${JSON.stringify(file, null, 2)}\n`, { privateDir: true });
}

/** @returns The value as a stored key, or null when it is not one. */
function asProvisioningKey(value: unknown): StoredProvisioningKey | null {
  if (!value || typeof value !== "object") return null;
  const key = value as StoredProvisioningKey;
  return typeof key.apiKey === "string" && key.apiKey && typeof key.orgId === "string" && typeof key.endpoints === "string"
    ? key
    : null;
}

/**
 * Stores a provisioning key in the keychain, or the fallback file when there is no keychain.
 *
 * @remarks
 * When the keychain takes it, only the entry's name goes to the file, so `logout` can find the
 * entry again: a keychain cannot be listed portably from the command line.
 */
export function saveProvisioningKey(key: StoredProvisioningKey): void {
  const account = provisioningKeyAccount(key.endpoints, key.orgId);
  const file = readKeyFile();
  if (keychainWrite(JSON.stringify(key), account)) {
    delete file.keys[account];
    if (!file.keychain.includes(account)) file.keychain.push(account);
  } else {
    file.keys[account] = key;
  }
  writeKeyFile(file);
}

/**
 * @returns The provisioning key for these endpoints and organization, from the keychain or the
 * fallback file; or null when there is none.
 */
export function loadProvisioningKey(endpoints: string, orgId: string): StoredProvisioningKey | null {
  const account = provisioningKeyAccount(endpoints, orgId);
  const raw = keychainRead(account);
  let key: StoredProvisioningKey | null = null;
  if (raw) {
    try {
      key = asProvisioningKey(JSON.parse(raw));
    } catch {
      key = null;
    }
  }
  key ??= asProvisioningKey(readKeyFile().keys[account]);
  // A hash collision, or a hand-edited file, must not send one environment's key to another.
  return key && key.endpoints === endpoints && key.orgId === orgId ? key : null;
}

/** Forgets the provisioning key for these endpoints and organization, wherever it is stored. */
export function clearProvisioningKey(endpoints: string, orgId: string): void {
  const account = provisioningKeyAccount(endpoints, orgId);
  keychainClear(account);
  const file = readKeyFile();
  if (!(account in file.keys) && !file.keychain.includes(account)) return;
  delete file.keys[account];
  file.keychain = file.keychain.filter((name) => name !== account);
  writeKeyFile(file);
}

/**
 * Forgets every provisioning key, in every environment and organization.
 *
 * @remarks
 * For `logout`. The keys stay valid on the service until revoked; this only removes the CLI's
 * copy, so the next provisioning call after signing in again mints a new one.
 */
export function clearProvisioningKeys(): void {
  for (const account of readKeyFile().keychain) {
    if (account.startsWith("provisioning:")) keychainClear(account);
  }
  try {
    rmSync(provisioningKeysPath());
  } catch {
    return;
  }
}

/** `nxis_live_mcp_abc123_secret…` → `…cret`. Enough to recognize, useless to steal. */
export function preview(secret: string): string {
  if (secret.length <= 4) return "…";
  return `…${secret.slice(-4)}`;
}
