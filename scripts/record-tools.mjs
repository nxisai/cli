#!/usr/bin/env node
/**
 * Records what the endpoints list, for the schema-drift test.
 *
 * @remarks
 * Writes `test/fixtures/provisioning-tools.json`: the name, description and input schema of every
 * tool the provisioning endpoint lists, and of every tool a site's own MCP endpoint lists. The
 * tests compare the definitions in `src/tools/` against it, so re-recording after a server change
 * makes the tests say exactly which definition no longer matches.
 *
 * It uses the CLI's own client, built into `dist/`, and so the CLI's own sign-in, organization
 * and provisioning key: sign in to the environment to record (`nxis login`, `nxis orgs use`)
 * first. The fixture holds no URL, key or organization.
 *
 * The site endpoint is recorded when a site is named (`--site`, `--site-url`, or
 * `NXIS_SITE_MCP_URL`); otherwise the fixture keeps the site tools it already has. The site's MCP
 * server must be public, since no key is sent to it.
 *
 * @example
 * ```sh
 * npm run build
 * NXIS_API=http://localhost:<port> node scripts/record-tools.mjs --site example.com
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE = resolve(root, "test/fixtures/provisioning-tools.json");

const ABOUT =
  "The tools/list results the tool definitions in src/tools/ are checked against. " +
  "Re-record with `node scripts/record-tools.mjs` after `npm run build`.";

/**
 * @param {Array<{ name: string, description?: string, inputSchema?: unknown }>} tools - As listed.
 * @returns {Array<{ name: string, description: string | null, inputSchema: unknown }>} What the
 * fixture keeps of each, sorted by name so a re-recording diffs cleanly.
 */
export function recordable(tools) {
  return tools
    .map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? { type: "object" } }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {{ provisioning: unknown[], site: unknown[] | null }} listed - What each endpoint listed;
 * `site` is null when the site endpoint was not recorded.
 * @param {{ site?: { tools: unknown[] } } | null} previous - The fixture being replaced.
 * @param {Date} now - When it was recorded.
 * @returns {object} The new fixture.
 */
export function toFixture(listed, previous, now) {
  return {
    about: ABOUT,
    source: "recorded",
    recorded_at: now.toISOString().slice(0, 10),
    provisioning: { tools: recordable(/** @type {any} */ (listed.provisioning)) },
    site: listed.site ? { tools: recordable(/** @type {any} */ (listed.site)) } : (previous?.site ?? { tools: [] }),
  };
}

async function main() {
  const dist = resolve(root, "dist");
  if (!existsSync(resolve(dist, "tools/index.js"))) {
    console.error("record-tools: run `npm run build` first; this uses the built CLI.");
    process.exit(2);
  }
  const imp = (path) => import(resolve(dist, path));
  const [{ parseArgs, str }, { resolveConfig }, { createIo }, { loadSettings }, client, endpoint, tools] =
    await Promise.all([
      imp("args.js"),
      imp("config.js"),
      imp("output.js"),
      imp("state.js"),
      imp("provisioning/client.js"),
      imp("provisioning/endpoint.js"),
      imp("tools/index.js"),
    ]);

  const { flags } = parseArgs(process.argv.slice(2));
  const org = str(flags, "org");
  const site = str(flags, "site");
  const siteUrl = str(flags, "site-url");
  const out = str(flags, "out") ?? FIXTURE;
  const ctx = {
    config: resolveConfig({ ...(str(flags, "api") ? { api: str(flags, "api") } : {}), saved: loadSettings() }),
    io: createIo(false),
    ...(org ? { orgOverride: org } : {}),
    ...(site ? { siteOverride: site } : {}),
  };

  try {
    const provisioning = await endpoint.withProvisioning(ctx, async (c) => {
      const listed = await c.listTools();
      let siteTools = null;
      if (siteUrl || site || process.env[tools.SITE_MCP_URL_ENV]) {
        const url = siteUrl ?? (await tools.siteMcpUrl(ctx, { provisioning: c }));
        siteTools = await client.withMcpClient(endpoint.siteEndpoint(url), (s) => s.listTools());
      }
      return { provisioning: listed, site: siteTools };
    });
    const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    writeFileSync(out, `${JSON.stringify(toFixture(provisioning, previous, new Date()), null, 2)}\n`);
    console.error(
      `record-tools: ${provisioning.provisioning.length} provisioning tools` +
        (provisioning.site ? `, ${provisioning.site.length} site tools` : ", site tools kept") +
        ` → ${out}`,
    );
  } catch (err) {
    console.error(`record-tools: ${err?.message ?? err}${err?.reason ? ` (${err.reason})` : ""}`);
    process.exit(typeof err?.exitCode === "number" && err.exitCode !== 0 ? err.exitCode : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
