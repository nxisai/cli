/**
 * The app inside each standalone tarball: the CLI bundled into one file, with the licenses of
 * everything bundled into it.
 *
 *   app/dist/nxis.mjs        src/cli.ts and its dependencies (the MCP SDK, zod and theirs)
 *   app/package.json         the version `nxis --version` reports
 *   app/THIRD_PARTY_LICENSES every bundled package's name, version and license text
 *
 * The bundle is built from the TypeScript sources with esbuild, so it needs no `npm run build`
 * first, only src/build-config.ts (`npm run build:config`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..");

/** The package's name and version, from package.json. */
export function packageInfo() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(pkg.version)) throw new Error(`package.json's version isn't a release version: ${pkg.version}`);
  return { name: pkg.name, version: pkg.version };
}

/**
 * Builds the app into `dir`.
 *
 * @param dir - Where app/ goes; created if missing.
 * @param opts.define - Constants to replace in the bundle (see src/release-keys.ts).
 * @returns The bundled packages, as `name@version`.
 */
export async function buildApp(dir, { define = {} } = {}) {
  if (!existsSync(join(root, "src/build-config.ts"))) throw new Error("run `npm run build:config` first");
  const { version } = packageInfo();
  mkdirSync(join(dir, "dist"), { recursive: true });
  const result = await build({
    entryPoints: [join(root, "src/cli.ts")],
    outfile: join(dir, "dist/nxis.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    keepNames: true,
    // Licenses are collected below, whole, instead of the scattered comments.
    legalComments: "none",
    metafile: true,
    // Some dependencies are CommonJS and call require(); give the ES module bundle one.
    banner: { js: "import { createRequire as __nxisRequire } from 'node:module'; const require = __nxisRequire(import.meta.url);" },
    define,
    logLevel: "warning",
  });
  // The shebang from src/cli.ts is dropped: the bundle runs on the Node next to it, never on
  // whichever `node` is on PATH.
  const bundle = join(dir, "dist/nxis.mjs");
  writeFileSync(bundle, readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@nxisai/cli", version, type: "module", private: true }, null, 2) + "\n");
  const packages = bundledPackages(result.metafile);
  writeFileSync(join(dir, "THIRD_PARTY_LICENSES"), licenses(packages));
  return packages.map((p) => `${p.name}@${p.version}`);
}

/** Every package under node_modules that the bundle took code from. */
function bundledPackages(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const abs = resolve(root, input);
    const at = abs.lastIndexOf(`${sep}node_modules${sep}`);
    if (at === -1) continue;
    const rest = abs.slice(at + `${sep}node_modules${sep}`.length).split(sep);
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    dirs.add(join(abs.slice(0, at), "node_modules", name));
  }
  return [...dirs]
    .map((d) => {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
      const file = readdirSync(d).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      if (!file) throw new Error(`${pkg.name} has no license file to ship with the bundle`);
      return { name: pkg.name, version: pkg.version, license: pkg.license ?? "see below", text: readFileSync(join(d, file), "utf8").trim() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function licenses(packages) {
  const head =
    "The packages below are bundled into dist/nxis.mjs. Each is listed with its version, its\n" +
    "license, and the license text from its own distribution.\n";
  return [head, ...packages.map((p) => `${"=".repeat(72)}\n${p.name} ${p.version} (${p.license})\n${"=".repeat(72)}\n\n${p.text}\n`)].join("\n");
}
