/**
 * A signed standalone release for tests, and a local server that serves it with GitHub's paths.
 *
 * @remarks
 * The release is built by release/build.mjs and signed by release/sign.mjs, for real, with two
 * stand-ins: a two-line script that runs the Node running the tests replaces Node.js's download,
 * and the signing key is a throwaway pair made in the fixture's temporary folder.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";

export const root = join(import.meta.dirname, "../..");
export const host = `${process.platform}-${process.arch}`;
export const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(host);

export interface Release {
  /** The fixture's temporary folder. */
  dir: string;
  /** The built and signed release (download/v<v>/…, latest/download/…). */
  out: string;
  version: string;
  /** The test key's public half, as pinned keys are written. */
  pub: string;
  keyFile: string;
  /** Builds and signs another version of the release into `out`. */
  buildVersion(version: string): void;
  remove(): void;
}

/**
 * Builds and signs a release of this checkout for this machine.
 *
 * @remarks
 * Another version is built from a copy of the checkout's package.json with that version, in a
 * temporary copy of the sources, so the checkout is never changed.
 */
export function buildRelease(): Release {
  const dir = mkdtempSync(join(tmpdir(), "nxis-release-fixture-"));
  const out = join(dir, "out");
  const keyFile = join(dir, "test-key.pem");
  const printed = execFileSync(process.execPath, [join(root, "release/keygen.mjs"), keyFile], { encoding: "utf8" });
  const pub = /Public key:\n\n {2}(\S+)/.exec(printed)![1]!;
  const stand = join(dir, "node");
  writeFileSync(stand, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(stand, 0o755);
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

  const build = (from: string) => {
    const args = ["--platforms", "host", "--out", out, "--node-binary", stand, "--trust-key", pub];
    const r = spawnSync(process.execPath, [join(from, "release/build.mjs"), ...args], { cwd: from, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`build.mjs failed:\n${r.stderr}`);
    const s = spawnSync(process.execPath, [join(from, "release/sign.mjs"), "--out", out, "--key", keyFile, "--trust-key", pub], {
      cwd: from,
      encoding: "utf8",
    });
    if (s.status !== 0) throw new Error(`sign.mjs failed:\n${s.stderr}`);
  };
  build(root);

  return {
    dir,
    out,
    version,
    pub,
    keyFile,
    buildVersion(v: string) {
      const copy = join(dir, `src-${v}`);
      if (!existsSync(copy)) {
        for (const f of ["release", "src", "LICENSE", "NOTICE", "TRADEMARK.md"]) cpSync(join(root, f), join(copy, f), { recursive: true });
        // node_modules is linked, not copied: the bundle reads its dependencies from it.
        execFileSync("ln", ["-s", join(root, "node_modules"), join(copy, "node_modules")]);
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
        writeFileSync(join(copy, "package.json"), JSON.stringify({ ...pkg, version: v }, null, 2));
      }
      build(copy);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Serves a folder over http on 127.0.0.1, as GitHub serves a release's files.
 *
 * @remarks
 * `latest/download/<file>` answers with a redirect to `download/v<latest>/<file>` when the folder
 * has `latest/download/manifest.json`, the way GitHub redirects to the latest release, so the
 * client's redirect handling is exercised.
 */
export async function serve(folder: string): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    requests.push(path);
    const latest = /^\/latest\/download\/([^/]+)$/.exec(path);
    if (latest) {
      try {
        const m = JSON.parse(readFileSync(join(folder, "latest/download/manifest.json"), "utf8")) as { version: string };
        res.writeHead(302, { location: `/download/v${m.version}/${latest[1]}` });
        res.end();
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    const file = normalize(join(folder, path));
    if (!file.startsWith(folder + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
