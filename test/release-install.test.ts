/**
 * release/install.sh, run for real with `sh` against a signed test release on a local server,
 * into a temporary HOME.
 *
 * The platform checks are exercised with stand-in `uname` and `ldd` commands on PATH, so the
 * Windows (Git Bash, MSYS2, Cygwin) and musl branches run on any machine.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease, host, serve, supported, type Release } from "./support/release-fixture.js";

let release: Release;
let server: Awaited<ReturnType<typeof serve>>;
let installer: string;

beforeAll(async () => {
  if (!supported) return;
  release = buildRelease();
  server = await serve(release.out);
  installer = join(release.out, "download", `v${release.version}`, "install.sh");
}, 180_000);

afterAll(async () => {
  await server?.close();
  release?.remove();
});

/** A fresh HOME, and a PATH with the system's tools, node (for the fallback check) and `stubs`. */
function sandbox(stubs: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "nxis-install-home-"));
  const bin = join(home, "stubs");
  mkdirSync(bin);
  for (const [name, script] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  // Not spawnSync: the server runs in this process, and has to keep answering meanwhile.
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("sh", [installer, ...args], {
        env: { HOME: home, PATH, SHELL: "/bin/zsh", NXIS_RELEASES_URL: server.url, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  return { home, run, remove: () => rmSync(home, { recursive: true, force: true }) };
}

describe.skipIf(!supported)("install.sh", () => {
  it("installs the latest release into ~/.nxis with a launcher in ~/.local/bin", async () => {
    const s = sandbox();
    try {
      const r = await s.run();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Installing nxis ${release.version} (${host})`);
      expect(r.stdout).toContain("Checked the signature and checksum.");
      expect(r.stdout).toContain(`Installed nxis ${release.version}`);
      // It says what it collects, which is nothing, and how it would be turned off.
      expect(r.stdout).toContain("Telemetry: this version of nxis sends none");
      expect(r.stdout).toContain("DO_NOT_TRACK=1");

      expect(readlinkSync(join(s.home, ".nxis/current"))).toBe(`versions/${release.version}`);
      const launcher = readFileSync(join(s.home, ".local/bin/nxis"), "utf8");
      expect(launcher).toContain(`NXIS_LAUNCHER="${s.home}/.local/bin/nxis"`);
      expect(launcher).toContain(`NXIS_INSTALL_DIR="${s.home}/.nxis"`);
      expect(launcher).toContain(`exec "${s.home}/.nxis/current/bin/node" "${s.home}/.nxis/current/app/dist/nxis.mjs" "$@"`);
      const v = spawnSync(join(s.home, ".local/bin/nxis"), ["--version"], { encoding: "utf8", env: { HOME: s.home, PATH: "/usr/bin:/bin" } });
      expect(v.stdout.trim()).toBe(release.version);

      // The PATH line goes into the shell's startup file once.
      expect(readFileSync(join(s.home, ".zshrc"), "utf8")).toContain(`export PATH="${s.home}/.local/bin:$PATH"`);
      expect((await s.run()).status).toBe(0);
      expect(readFileSync(join(s.home, ".zshrc"), "utf8").split("# nxis").length).toBe(2);

      // It found the version through the latest redirect, then fetched that version's files.
      expect(server.requests).toContain("/latest/download/manifest.json");
      expect(server.requests).toContain(`/download/v${release.version}/manifest.json.sig`);
    } finally {
      s.remove();
    }
  });

  it("keeps this version and the one before it", async () => {
    const s = sandbox();
    try {
      const versions = join(s.home, ".nxis/versions");
      mkdirSync(versions, { recursive: true });
      for (const [i, v] of ["0.0.1", "0.0.2"].entries()) {
        mkdirSync(join(versions, v));
        const t = new Date(Date.now() - (10 - i) * 60_000);
        utimesSync(join(versions, v), t, t);
      }
      expect((await s.run([], { NXIS_NO_MODIFY_PATH: "1" })).status).toBe(0);
      expect(readdirSync(versions).sort()).toEqual(["0.0.2", release.version].sort());
      expect(existsSync(join(s.home, ".zshrc"))).toBe(false);
    } finally {
      s.remove();
    }
  });

  it("installs from a folder of the release's files", async () => {
    const s = sandbox();
    try {
      // What `gh release download` writes: every asset in one folder.
      const flat = join(s.home, "assets");
      cpSync(join(release.out, "download", `v${release.version}`), flat, { recursive: true });
      const r = await s.run(["--from", flat], { NXIS_RELEASES_URL: "https://127.0.0.2.invalid" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Installed nxis ${release.version}`);
    } finally {
      s.remove();
    }
  });

  it("refuses a tarball that doesn't match the signed manifest", async () => {
    const s = sandbox();
    try {
      const flat = join(s.home, "assets");
      cpSync(join(release.out, "download", `v${release.version}`), flat, { recursive: true });
      const tarball = join(flat, `nxis-${release.version}-${host}.tar.gz`);
      const bytes = readFileSync(tarball);
      writeFileSync(tarball, Buffer.concat([bytes, Buffer.from("tampered")]));
      const r = await s.run(["--from", flat]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("does not match the signed manifest");
      expect(existsSync(join(s.home, ".nxis/current"))).toBe(false);
      expect(existsSync(join(s.home, ".local/bin/nxis"))).toBe(false);
    } finally {
      s.remove();
    }
  });

  it("refuses a manifest signed by a key it doesn't carry", async () => {
    const s = sandbox();
    try {
      const flat = join(s.home, "assets");
      cpSync(join(release.out, "download", `v${release.version}`), flat, { recursive: true });
      // A signature from another throwaway key, over the same bytes.
      const sig = spawnSync(
        process.execPath,
        [
          "-e",
          'const c=require("crypto"),f=require("fs");const {privateKey}=c.generateKeyPairSync("ed25519");' +
            'f.writeFileSync(process.argv[2], c.sign(null, f.readFileSync(process.argv[1]), privateKey).toString("base64"))',
          join(flat, "manifest.json"),
          join(flat, "manifest.json.sig"),
        ],
        { encoding: "utf8" },
      );
      expect(sig.status).toBe(0);
      const r = await s.run(["--from", flat]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("not signed by an NxisAI release key");
      expect(existsSync(join(s.home, ".nxis/current"))).toBe(false);
    } finally {
      s.remove();
    }
  });

  it("downloads over https only, or http to this machine", async () => {
    const s = sandbox();
    try {
      const r = await s.run([], { NXIS_RELEASES_URL: "http://example.com/releases" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("has to be an https URL");
    } finally {
      s.remove();
    }
  });

  for (const uname of ["MINGW64_NT-10.0-22631", "MSYS_NT-10.0-22631", "CYGWIN_NT-10.0-22631"]) {
    it(`points to WSL on ${uname.split("_")[0]}`, async () => {
      const s = sandbox({ uname: `[ "$1" = -m ] && echo x86_64 || echo ${uname}` });
      try {
        const r = await s.run();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("on Windows, install nxis inside WSL");
        expect(r.stderr).toContain("wsl --install");
        expect(existsSync(join(s.home, ".nxis"))).toBe(false);
      } finally {
        s.remove();
      }
    });
  }

  it("points to npm on musl Linux", async () => {
    const s = sandbox({
      uname: '[ "$1" = -m ] && echo x86_64 || echo Linux',
      ldd: 'echo "musl libc (x86_64)"; echo "Version 1.2.5"; exit 1',
    });
    try {
      const r = await s.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("this Linux uses musl");
      expect(r.stderr).toContain("npm i -g @nxisai/cli");
      expect(existsSync(join(s.home, ".nxis"))).toBe(false);
    } finally {
      s.remove();
    }
  });

  it("refuses an unknown processor", async () => {
    const s = sandbox({ uname: '[ "$1" = -m ] && echo riscv64 || echo Linux', ldd: "echo 'ldd (GNU libc) 2.39'" });
    try {
      const r = await s.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("riscv64 processors aren't supported");
    } finally {
      s.remove();
    }
  });
});
