/**
 * Standalone releases: checking that a release is signed, and what it contains.
 *
 * @remarks
 * A release's `manifest.json` lists every file of a version with its sha256 and size, and
 * `manifest.json.sig` is an Ed25519 signature over the manifest's exact bytes. A file is trusted
 * only when it matches a manifest signed by one of the keys in `./release-keys.ts`; the `.sha256`
 * files next to the tarballs are a convenience for people, never what this checks against.
 */

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RELEASE_KEY_PLACEHOLDER, RELEASE_KEYS } from "./release-keys.js";

/**
 * Set by `release/build.mjs` in the standalone bundle: the keys that build trusts, the pinned
 * ones plus any test key. Undefined when the CLI runs from npm or a checkout.
 */
declare const __NXIS_RELEASE_KEYS__: readonly string[] | undefined;

/** The manifest's `name`. */
export const MANIFEST_NAME = "nxis";

/** The platforms there are standalone builds for, as in `release/platforms.mjs`. */
export const RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

/** A release that can't be installed. `retryable` when a download failed, not the release's checks. */
export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** `manifest.json`: every file of a version, signed in `manifest.json.sig`. */
export interface ReleaseManifest {
  name: typeof MANIFEST_NAME;
  version: string;
  files: Record<string, { sha256: string; size: number }>;
}

/** @returns The keys given, without the placeholder. */
export function usableKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((k) => k && k !== RELEASE_KEY_PLACEHOLDER && !k.startsWith("PLACEHOLDER"));
}

/** @returns The release keys this build trusts. */
export function trustedReleaseKeys(): readonly string[] {
  return usableKeys(typeof __NXIS_RELEASE_KEYS__ !== "undefined" ? __NXIS_RELEASE_KEYS__ : RELEASE_KEYS);
}

/** A version as releases name them: `1.2.3` or `1.2.3-beta.1`. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/**
 * Checks the signature over the manifest's exact bytes against each key, then its shape.
 *
 * @param body - `manifest.json`, as downloaded.
 * @param signature - `manifest.json.sig`: base64 Ed25519.
 * @param keys - Base64 SPKI DER public keys; the placeholder never counts.
 * @returns The manifest, once one of the keys signed it.
 * @throws ReleaseError when no key signed it, or it is malformed.
 */
export function verifyManifest(body: Buffer, signature: string, keys: readonly string[]): ReleaseManifest {
  const usable = usableKeys(keys);
  if (usable.length === 0) {
    throw new ReleaseError("this nxis has no release key to check an update with; reinstall it with the installer");
  }
  const sig = Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64) throw new ReleaseError("the release's signature is malformed");
  const signed = usable.some((k) => {
    try {
      const key = createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519" && verify(null, body, key, sig);
    } catch {
      return false;
    }
  });
  if (!signed) throw new ReleaseError("the release isn't signed by an NxisAI release key");

  let m: unknown;
  try {
    m = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ReleaseError("the release's manifest isn't JSON");
  }
  const r = m as Partial<ReleaseManifest> | null;
  const ok =
    typeof r === "object" &&
    r !== null &&
    r.name === MANIFEST_NAME &&
    typeof r.version === "string" &&
    VERSION_PATTERN.test(r.version) &&
    typeof r.files === "object" &&
    r.files !== null &&
    Object.values(r.files).every(
      (f) => typeof f?.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isSafeInteger(f.size) && f.size > 0,
    );
  if (!ok) throw new ReleaseError("the release's manifest is malformed");
  return r as ReleaseManifest;
}

/** @returns The tarball for one platform, from a verified manifest that has to be for `version`. */
export function releaseTarball(
  m: ReleaseManifest,
  version: string,
  platform: string,
): { name: string; sha256: string; size: number } {
  if (m.version !== version) throw new ReleaseError(`the release's manifest is for ${m.version}, not ${version}`);
  const name = `nxis-${version}-${platform}.tar.gz`;
  const f = Object.hasOwn(m.files, name) ? m.files[name] : undefined;
  if (!f) throw new ReleaseError(`nxis ${version} has no build for ${platform}`);
  return { name, ...f };
}

/** @returns This machine's platform, as releases name it. */
export function releasePlatform(platform: string = process.platform, arch: string = process.arch): string {
  const p = `${platform}-${arch}`;
  if (!(RELEASE_PLATFORMS as readonly string[]).includes(p)) throw new ReleaseError(`there is no standalone nxis for ${p}`);
  return p;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** @returns Whether a URL is https, or http to this machine (a local test release). */
export function isSecureUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.test(u.hostname));
}

/** @throws ReleaseError unless {@link isSecureUrl}. */
export function assertSecureUrl(url: string): void {
  if (!isSecureUrl(url)) throw new ReleaseError(`${url} isn't an https URL; nxis downloads releases over https only`);
}

export interface GetOptions {
  /** How long the connection may sit idle. */
  timeoutMs: number;
  headers?: Record<string, string>;
}

/**
 * A GET that follows up to 5 redirects itself, so that every hop has to be https (or loopback).
 * GitHub answers a release download with a redirect to its file storage.
 */
export function secureGet(url: string, o: GetOptions, hops = 0): Promise<IncomingMessage> {
  try {
    assertSecureUrl(url);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { "user-agent": "nxis-update", ...o.headers };
    const req = (u.protocol === "https:" ? httpsGet : httpGet)(u, { headers, timeout: o.timeoutMs }, (res) => {
      const location = res.headers.location;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (hops >= 5) return reject(new ReleaseError(`${url} redirects too many times`));
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          return reject(new ReleaseError(`${url} redirects to a bad URL`));
        }
        secureGet(next, o, hops + 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new ReleaseError(`${url} timed out`, true)));
    req.on("error", (e) => reject(e instanceof ReleaseError ? e : new ReleaseError(`couldn't download ${url}: ${e.message}`, true)));
  });
}

/** A small file over {@link secureGet}, refusing more than `maxBytes`. */
export async function secureGetBytes(url: string, maxBytes: number, o: GetOptions): Promise<Buffer> {
  const res = await secureGet(url, o);
  if (res.statusCode !== 200) {
    res.resume();
    throw new ReleaseError(`couldn't download ${url} (HTTP ${res.statusCode})`, true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      throw new ReleaseError(`${url} is larger than expected`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Downloads `url` into `file`, returning its sha256; anything over `maxBytes` stops it. */
async function download(url: string, file: string, maxBytes: number): Promise<string> {
  const res = await secureGet(url, { timeoutMs: 60_000 });
  if (res.statusCode !== 200) {
    res.resume();
    throw new ReleaseError(`couldn't download ${url} (HTTP ${res.statusCode})`, true);
  }
  const hash = createHash("sha256");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) return done(new ReleaseError(`${url} is larger than expected`, true));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(res, count, createWriteStream(file, { mode: 0o600 }));
  return hash.digest("hex");
}

/** Where a release's files are: a releases URL (GitHub's layout), or a local folder of them. */
export type ReleaseSource = { url: string } | { from: string };

const sourceOf = (s: ReleaseSource): string => ("from" in s ? s.from : s.url);

/** Reads one of a version's files, small enough to hold in memory. */
async function readReleaseFile(s: ReleaseSource, version: string, name: string, maxBytes: number): Promise<Buffer> {
  if ("from" in s) {
    const file = join(s.from, name);
    if (!existsSync(file)) throw new ReleaseError(`${s.from} has no ${name}`);
    if (statSync(file).size > maxBytes) throw new ReleaseError(`${file} is larger than expected`);
    return readFileSync(file);
  }
  return secureGetBytes(`${s.url}/download/v${version}/${name}`, maxBytes, { timeoutMs: 15_000, headers: { "cache-control": "no-cache" } });
}

/**
 * The newest release, from the manifest GitHub's `latest` redirect leads to (or the folder's), once
 * its signature checks out.
 */
export async function latestRelease(s: ReleaseSource, keys: readonly string[] = trustedReleaseKeys(), timeoutMs = 10_000): Promise<ReleaseManifest> {
  let body: Buffer;
  let sig: string;
  if ("from" in s) {
    body = await readReleaseFile(s, "", "manifest.json", 1 << 20);
    sig = (await readReleaseFile(s, "", "manifest.json.sig", 4096)).toString("utf8");
  } else {
    assertSecureUrl(s.url);
    const get = { timeoutMs, headers: { "cache-control": "no-cache" } };
    // Unchecked, only to learn the version; that version's own files are what get checked.
    const pointer = await secureGetBytes(`${s.url}/latest/download/manifest.json`, 1 << 20, get);
    let version: unknown;
    try {
      version = (JSON.parse(pointer.toString("utf8")) as { version?: unknown }).version;
    } catch {
      version = undefined;
    }
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new ReleaseError(`${s.url} has no readable latest release`);
    body = await readReleaseFile(s, version, "manifest.json", 1 << 20);
    sig = (await readReleaseFile(s, version, "manifest.json.sig", 4096)).toString("utf8");
  }
  return verifyManifest(body, sig, keys);
}

/** The launcher in the bin folder: the same one install.sh writes. */
export function launcherScript(installDir: string, launcher: string, url: string): string {
  return `#!/bin/sh
# nxis launcher, written by the nxis installer. nxis runs on its own Node.js in ${installDir}/current.
# NXIS_LAUNCHER, NXIS_INSTALL_DIR and NXIS_RELEASES_URL tell nxis how it was installed, for nxis update.
NXIS_LAUNCHER="${launcher}" NXIS_INSTALL_DIR="${installDir}" NXIS_RELEASES_URL="${url}" \\
  exec "${installDir}/current/bin/node" "${installDir}/current/app/dist/nxis.mjs" "$@"
`;
}

export interface InstallOptions {
  source: ReleaseSource;
  version: string;
  /** The install folder (~/.nxis): versions/<v>/ and the `current` link. */
  dir: string;
  /** The launcher to rewrite, ~/.local/bin/nxis. */
  bin: string;
  /** The releases URL the launcher keeps, for the next update. */
  url: string;
  /** Versions to keep besides the new one (the running one), when older ones are removed. */
  keep?: readonly string[];
  platform?: string;
  keys?: readonly string[];
  log?: (s: string) => void;
}

/**
 * Installs one version the way install.sh does, checking it first: the manifest's signature
 * against the trusted keys, then the tarball's sha256 and size against the manifest. It unpacks
 * into a folder inside `dir` and switches the `current` link in one rename, so an nxis that's
 * running, such as an agent's `nxis mcp serve`, keeps working until it exits.
 */
export async function installRelease(o: InstallOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const platform = o.platform ?? releasePlatform();
  const keys = o.keys ?? trustedReleaseKeys();
  if (!VERSION_PATTERN.test(o.version)) throw new ReleaseError(`'${o.version}' isn't a version`);
  if (!/^[^"`$\\]+$/.test(o.dir + o.bin) || !/^[^"`$\\\s]+$/.test(o.url)) throw new ReleaseError("the install paths can't hold quotes, backticks, $ or backslashes");
  if ("url" in o.source) assertSecureUrl(o.source.url);

  const body = await readReleaseFile(o.source, o.version, "manifest.json", 1 << 20);
  const sig = (await readReleaseFile(o.source, o.version, "manifest.json.sig", 4096)).toString("utf8");
  const tarball = releaseTarball(verifyManifest(body, sig, keys), o.version, platform);
  log(`Downloading nxis ${o.version} (${platform}, ${(tarball.size / 1e6).toFixed(1)} MB) from ${sourceOf(o.source)}…`);

  mkdirSync(join(o.dir, "versions"), { recursive: true });
  const tmp = mkdtempSync(join(o.dir, ".update-"));
  try {
    const file = join(tmp, tarball.name);
    let got: string;
    if ("from" in o.source) {
      const src = join(o.source.from, tarball.name);
      if (!existsSync(src)) throw new ReleaseError(`${o.source.from} has no ${tarball.name}`);
      if (statSync(src).size !== tarball.size) throw new ReleaseError(`${tarball.name} doesn't match the signed manifest`);
      copyFileSync(src, file);
      got = createHash("sha256").update(readFileSync(file)).digest("hex");
    } else {
      // Anything bigger than the size the manifest gives isn't the file it lists.
      got = await download(`${o.source.url}/download/v${o.version}/${tarball.name}`, file, tarball.size);
    }
    if (got !== tarball.sha256) throw new ReleaseError(`${tarball.name} doesn't match the signed manifest; try again`);
    log("Checked the signature and checksum.");

    const name = tarball.name.replace(/\.tar\.gz$/, "");
    execFileSync("tar", ["-xzf", file, "-C", tmp], { stdio: ["ignore", "ignore", "pipe"] });
    const unpacked = join(tmp, name);
    for (const f of ["bin/node", "app/dist/nxis.mjs"]) {
      if (!existsSync(join(unpacked, f))) throw new ReleaseError(`${tarball.name} is missing ${f}`);
    }

    // Into place: any folder of the same version moves aside first, so `current` never points
    // at a half-written one.
    const target = join(o.dir, "versions", o.version);
    if (existsSync(target)) renameSync(target, join(tmp, "replaced"));
    renameSync(unpacked, target);
    const now = new Date();
    utimesSync(target, now, now); // newest first, as install.sh's cleanup expects

    const link = join(o.dir, "current");
    const next = join(o.dir, "current.tmp");
    rmSync(next, { force: true });
    symlinkSync(join("versions", o.version), next);
    // rename(2) replaces the old link itself, never following it.
    renameSync(next, link);

    mkdirSync(dirname(o.bin), { recursive: true });
    const launcherTmp = `${o.bin}.tmp`;
    writeFileSync(launcherTmp, launcherScript(o.dir, o.bin, o.url));
    chmodSync(launcherTmp, 0o755);
    renameSync(launcherTmp, o.bin);

    // Keep this version and the ones asked for; remove older ones.
    const keep = new Set([o.version, ...(o.keep ?? [])]);
    for (const v of readdirSync(join(o.dir, "versions"))) {
      const p = join(o.dir, "versions", v);
      if (!keep.has(v) && statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
