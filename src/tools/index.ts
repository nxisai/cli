/**
 * The registry of NxisAI tools the CLI and `nxis mcp serve` share.
 *
 * @remarks
 * A command imports the tool it needs and calls `run`, which validates the arguments, fills in
 * the site, and calls the right endpoint:
 *
 * ```ts
 * import { verifySite } from "../tools/index.js";
 *
 * const { data } = await verifySite.run(ctx, { mode: "token" });
 * data.meta_tag; // typed: VerifySiteResult
 * ```
 *
 * A command making several calls opens one connection and passes it, so the key is read and the
 * session set up once:
 *
 * ```ts
 * await withProvisioning(ctx, async (provisioning) => {
 *   const created = await createSite.run(ctx, { url }, { provisioning });
 *   await setSiteName.run(ctx, { site: created.data.site, display_name: name }, { provisioning });
 * });
 * ```
 *
 * `nxis mcp serve` registers every entry of {@link TOOLS} as it is:
 *
 * ```ts
 * for (const tool of TOOLS) {
 *   server.registerTool(
 *     tool.name,
 *     { description: tool.description, inputSchema: tool.input, annotations: annotationsOf(tool) },
 *     async (args) => {
 *       const out = await tool.run(ctx, args);
 *       return { content: [{ type: "text", text: out.text }], structuredContent: out.raw.structuredContent };
 *     },
 *   );
 * }
 * ```
 *
 * Importing this module loads zod, not the MCP SDK; the SDK is loaded when a tool first runs.
 */

import type { ToolDef } from "./define.js";
import {
  aioFiles,
  bindMcpAction,
  bulkAutofill,
  crawlSitemap,
  createSite,
  enablePublicMcp,
  listInApp,
  listSites,
  mcpSettings,
  onPageAgent,
  publishEntities,
  setSiteName,
  siteTag,
  verifySite,
} from "./provisioning.js";
import { listTypes, query } from "./reads.js";
import { CONNECTION_TOOLS } from "./connections.js";

export * from "./define.js";
export * from "./provisioning.js";
export * from "./reads.js";
export * from "./connections.js";
export {
  findSite,
  hostOf,
  looksLikeSiteId,
  matchSite,
  resolveSiteId,
  SITE_MCP_URL_ENV,
  siteMcpUrl,
  type SiteMatch,
} from "./sites.js";

/**
 * Every tool, in the order the onboarding runs them: sites, data, MCP and discovery, then reads.
 * The connection tools sit beside `nxis_bind_mcp_action`; they are the CLI's own (surface `local`).
 *
 * @remarks
 * Typed loosely so tools with different schemas share one list; a command that wants typed input
 * and output imports the tool itself.
 */
export const TOOLS: readonly ToolDef[] = [
  listSites,
  createSite,
  verifySite,
  siteTag,
  setSiteName,
  crawlSitemap,
  bulkAutofill,
  publishEntities,
  enablePublicMcp,
  mcpSettings,
  bindMcpAction,
  ...CONNECTION_TOOLS,
  onPageAgent,
  aioFiles,
  listInApp,
  listTypes,
  query,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** @returns The tool with this name, or undefined. */
export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}
