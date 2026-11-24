/**
 * The hosted agent tools, which the CLI answers itself (surface `local`) over the sites API.
 *
 * @remarks
 * They do what `nxis agents status|catalog|enable|configure|disable|pause|resume|brand` do, through
 * the same code, so a tool result is the command's `--json` object; `next` names the tool call
 * that takes the next step. Settings are given by name, as `nxis_agents_catalog` lists them, and
 * checked against the agent's own setup before anything is sent.
 *
 * `nxis mcp serve` confirms with the user, over elicitation, before a call that changes what the
 * site's visitors meet: turning an agent on (after offering the connection and the agreement it
 * needs), changing an agent that is on, turning one off, resuming, and the chat's branding. A
 * pause needs no confirmation: it is the safe direction.
 *
 * The operations are imported when a tool runs, so importing the registry loads zod alone.
 */

import { z } from "zod";
import { defineLocalTool } from "./define.js";

type Result = Record<string, unknown>;

/** @returns The operations, loaded on first use. */
const ops = () => import("../guided/agents.js");

/** The `site` argument: an id or a domain, defaulting to the CLI's current site. */
const site = z.string().describe("Site id or domain. Defaults to the site saved in the CLI.").optional();

/** An agent, by catalog id. */
const agent = z.string().trim().min(1).max(80).describe("The agent's catalog id, such as quote or booking (nxis_agents_catalog lists them).");

/** Settings by name, as `nxis_agents_catalog` lists them. */
const settings = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
  .describe(
    "Settings by name, as nxis_agents_catalog lists them for the agent (its `flags`, by `setting`): text, a whole " +
      "number, true or false, or a list of text, within the limits listed there. Settings left out keep their value.",
  )
  .optional();

export const agentsStatusTool = defineLocalTool<Result>()({
  name: "nxis_agents_status",
  description:
    "What the site's hosted agents are doing: each agent by catalog id with its state (off, needs_setup, preview, " +
    "paused, live) and why, the site-wide pause, whether visitors are reached, and what holds the site back from " +
    "going live (the data processing agreement). The same facts as `nxis agents status`. Read-only.",
  input: z.strictObject({ site }),
  takesSite: true,
  readOnly: true,
  hints: { openWorld: false },
  async call(ctx, args) {
    const { agentsStatusOp } = await ops();
    return agentsStatusOp(ctx, args.site);
  },
});

export const agentsCatalogTool = defineLocalTool<Result>()({
  name: "nxis_agents_catalog",
  description:
    "The agents NxisAI can host for the site. Without agent: the catalog, with each agent's fit, readiness, state " +
    "and unmet prerequisites, filtered as asked. With agent: that one agent's settings as typed fields (type, " +
    "required, limits, allowed values, default, current value), its prerequisites with whether each is met, `unmet`, " +
    "and `enable_with`, the arguments nxis_enable_agent needs. Read-only. Call it before enabling or configuring.",
  input: z.strictObject({
    site,
    agent: agent.optional(),
    job: z.array(z.string().min(1)).describe("Without agent: only agents for these jobs.").optional(),
    industry: z.array(z.string().min(1)).describe("Without agent: only agents for these industries.").optional(),
    readiness: z
      .array(z.enum(["available", "early_access", "coming_soon"]))
      .describe("Without agent: only agents at these stages.")
      .optional(),
    added: z.boolean().describe("Without agent: true for the agents the site has added only, false for the others.").optional(),
    query: z.string().min(1).describe("Without agent: words to match.").optional(),
    by_fit: z.boolean().describe("Without agent: best fit for the site first.").optional(),
  }),
  takesSite: true,
  readOnly: true,
  hints: { openWorld: false },
  async call(ctx, args) {
    const { agentsCatalogOp } = await ops();
    return agentsCatalogOp(ctx, args);
  },
});

export const enableAgentTool = defineLocalTool<Result>()({
  name: "nxis_enable_agent",
  description:
    "Turn a hosted agent on, with its settings in the same save. Once on, it answers the site's visitors, so the " +
    "server confirms with the user first. Before that, it asks the user which of the site's connections the agent " +
    "sends its requests through, when it needs one and none is given (or returns the step to create one), and offers " +
    "the data processing agreement when the agents wait on it. A refusal says why (connection_required, " +
    "records_missing, actions_off, dpa_not_accepted …), which prerequisites are unmet, what was kept, and `next`: " +
    "the call that meets it. Call nxis_agents_catalog with the agent first for its settings.",
  input: z.strictObject({
    site,
    agent,
    settings,
    connection: z
      .string()
      .trim()
      .min(1)
      .describe("The connection (name or id) the agent sends its requests through, for an agent that needs one. Use one the user chose.")
      .optional(),
  }),
  takesSite: true,
  readOnly: false,
  // Makes the agent answer visitors, and may route their requests to the site's own servers.
  hints: { destructive: true, idempotent: true, openWorld: true },
  async call(ctx, args) {
    const { enableAgentOp } = await ops();
    return enableAgentOp(ctx, args);
  },
});

export const configureAgentTool = defineLocalTool<Result>()({
  name: "nxis_configure_agent",
  description:
    "Change a hosted agent's settings without turning it on or off. clear returns settings to their default. When " +
    "the agent is on, visitors see the change within seconds, so the server confirms with the user first; an agent " +
    "that is off is changed without asking.",
  input: z.strictObject({
    site,
    agent,
    settings,
    clear: z.array(z.string().min(1)).describe("Settings, by name, to return to their default.").optional(),
  }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { configureAgentOp } = await ops();
    return configureAgentOp(ctx, args);
  },
});

export const disableAgentTool = defineLocalTool<Result>()({
  name: "nxis_disable_agent",
  description:
    "Turn a hosted agent off: it stops answering the site's visitors. Its settings are kept, so turning it on again " +
    "brings it back as it was. The server confirms with the user first. To stop agents at once while something is " +
    "wrong, nxis_pause_agents is the quicker, reversible stop.",
  input: z.strictObject({ site, agent }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { disableAgentOp } = await ops();
    return disableAgentOp(ctx, args);
  },
});

export const pauseAgentsTool = defineLocalTool<Result>()({
  name: "nxis_pause_agents",
  description:
    "Pause hosted agents: one by agent, or with no agent every hosted agent on the site. tools pauses actions only " +
    "(tools that change something); answers go on. reason is what visitors are told. A pause is the safe direction, " +
    "so it needs no confirmation; nxis_resume_agents undoes it.",
  input: z.strictObject({
    site,
    agent: agent.optional(),
    tools: z.boolean().describe("Pause actions only, not answers. Defaults to false: every turn is refused.").optional(),
    reason: z.string().max(200).describe("What visitors are told, at most 200 characters. Without it, a message already set is kept.").optional(),
  }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: false, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { pauseAgentsOp } = await ops();
    return pauseAgentsOp(ctx, args);
  },
});

export const resumeAgentsTool = defineLocalTool<Result>()({
  name: "nxis_resume_agents",
  description:
    "Resume hosted agents: one agent's own pause, or with no agent the site-wide pause. Each is resumed on its own: " +
    "resuming the site leaves an agent paused by name paused. Agents that are on answer visitors again, so the server " +
    "confirms with the user first.",
  input: z.strictObject({ site, agent: agent.optional() }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { resumeAgentsOp } = await ops();
    return resumeAgentsOp(ctx, args);
  },
});

/** The parts of the chat's branding. */
const BRAND_PARTS = ["name", "logo", "accent", "privacy_url"] as const;

export const agentsBrandTool = defineLocalTool<Result>()({
  name: "nxis_agents_brand",
  description:
    "Set how the on-page chat looks to visitors: its name, logo (an https image URL), accent color (#rgb or #rrggbb) " +
    "and the link to the site's privacy page. Only the parts given change; clear returns parts to the default. The " +
    "server confirms with the user first.",
  input: z.strictObject({
    site,
    name: z.string().describe("The name on the chat button and in the chat.").optional(),
    logo: z.string().describe("The mark: a full https:// image URL.").optional(),
    accent: z.string().describe("The accent color, #rgb or #rrggbb.").optional(),
    privacy_url: z.string().describe("The site's privacy page, a full https:// URL, linked from the chat's notice.").optional(),
    clear: z.array(z.enum(BRAND_PARTS)).describe("Parts to return to the default.").optional(),
  }),
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
  async call(ctx, args) {
    const { brandAgentsOp } = await ops();
    return brandAgentsOp(ctx, args);
  },
});

/** Every hosted agent tool, in the order an agent uses them. */
export const AGENT_TOOLS = [
  agentsStatusTool,
  agentsCatalogTool,
  enableAgentTool,
  configureAgentTool,
  disableAgentTool,
  pauseAgentsTool,
  resumeAgentsTool,
  agentsBrandTool,
] as const;
