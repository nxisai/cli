#!/usr/bin/env node
/**
 * Writes src/build-config.ts from the build environment.
 *
 * @remarks
 * The Auth0 client id of a Native application is a public identifier, not a secret: the CLI is a
 * public client, sends no client secret, and relies on the device flow's code confirmation and
 * PKCE instead. It still isn't hardcoded in source, so one codebase can be built against a
 * different identity provider or client by whoever runs the build, locally from a shell or in
 * CI from a repository variable. Client ids are URL-safe strings, so any other value is
 * rejected as a mistake.
 *
 * @example
 * ```sh
 * node scripts/build-config.mjs               # embed NXIS_AUTH_CLIENT_ID if set, warn if not
 * node scripts/build-config.mjs --require     # fail when it is not set (used before publish)
 * node scripts/build-config.mjs --out <file>  # write somewhere else (used by tests)
 * ```
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const required = args.includes("--require");
const outIndex = args.indexOf("--out");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = outIndex !== -1 && args[outIndex + 1] ? resolve(args[outIndex + 1]) : resolve(root, "src/build-config.ts");

// NXIS_AUTH0_CLIENT_ID is the old name, kept working so an existing CI secret or shell export
// does not break on the rename. Drop it once those are updated; nothing outside this repository
// has ever seen either name, since the package is not published yet.
const legacy = (process.env.NXIS_AUTH0_CLIENT_ID ?? "").trim();
const clientId = (process.env.NXIS_AUTH_CLIENT_ID ?? "").trim() || legacy;

if (legacy && !(process.env.NXIS_AUTH_CLIENT_ID ?? "").trim()) {
  console.error("build-config: NXIS_AUTH0_CLIENT_ID is deprecated — rename it to NXIS_AUTH_CLIENT_ID.");
}

if (clientId && !/^[A-Za-z0-9_-]{16,64}$/.test(clientId)) {
  console.error("build-config: NXIS_AUTH_CLIENT_ID doesn't look like a client id.");
  process.exit(1);
}

if (required && !clientId) {
  console.error(
    "build-config: refusing to continue without NXIS_AUTH_CLIENT_ID.\n" +
      "A package built without it can't sign anyone in. Set it in your shell, or as a\n" +
      "repository variable in CI, and publish again.",
  );
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  "/** OAuth client id embedded at build time by scripts/build-config.mjs. Generated; do not edit or commit. */\n" +
    `export const BUILD_CLIENT_ID = ${JSON.stringify(clientId)};\n`,
);

console.error(
  clientId
    ? "build-config: client id embedded."
    : "build-config: NXIS_AUTH_CLIENT_ID not set — this build can only sign in if it's set at runtime.",
);
