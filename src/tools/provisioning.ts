/**
 * The tools on the organization's provisioning endpoint.
 *
 * @remarks
 * Names, descriptions and input schemas are the server's, word for word: the recorded `tools/list`
 * fixture is compared against these definitions in the tests, so a change on either side shows up
 * as a failing test rather than as an argument one side ignores.
 *
 * Every tool that acts on a site takes `site`, and on this endpoint it is required and must be the
 * site's id. `run` fills it from `--site` or the saved site and turns a domain into the id, so a
 * command passes everything else and leaves `site` out.
 *
 * The output types describe what the server sends today. They are not checked at run time; every
 * field may be absent, because the server drops fields it has no value for.
 */

import { z } from "zod";
import { defineTool } from "./define.js";

/** The `site` argument, as every site-scoped provisioning tool declares it. */
const site = z.string().describe("Site id. Required on the provisioning endpoint.").optional();

/** Fields a result may carry beyond the ones typed here. */
type Open = Record<string, unknown>;

/** A next step the server suggests, in words. */
interface Next {
  next?: string | string[];
  note?: string;
}

// ── sites ───────────────────────────────────────────────────────────────────

/** One site, as `nxis_list_sites` reports it. */
export interface SiteSummary extends Open {
  /** The id the other tools take as `site`. */
  site?: string;
  domain?: string;
  /** The domain reduced to a lowercase host, for matching what a person typed. */
  host?: string;
  display_name?: string;
  subdomain?: string;
  is_verified?: boolean;
  active?: boolean;
  /** Absent for a site whose MCP server has never been set up. */
  mcp?: { endpoint?: string; enabled?: boolean; is_public?: boolean; listed_in_app?: boolean };
}

/** `nxis_list_sites`. */
export interface ListSitesResult extends Open {
  organization?: string;
  count?: number;
  truncated?: boolean;
  sites?: SiteSummary[];
}

export const listSites = defineTool<ListSitesResult>()({
  name: "nxis_list_sites",
  description:
    "List the sites in this organization: each site's id (what other tools take as `site`), domain, display " +
    "name, whether it is verified, and its MCP server's state — enabled, public, listed in the NxisAI app. " +
    "`mcp` is absent for a site whose MCP server has never been set up. Read-only.",
  input: z.strictObject({
    limit: z.int().min(1).max(500).describe("Most sites to return. Default 100.").optional(),
  }),
  surface: "provisioning",
  readOnly: true,
  hints: { openWorld: false },
});

/** `nxis_create_site`. */
export interface CreateSiteResult extends Open, Next {
  site?: string;
  domain?: string;
  subdomain?: string;
  is_verified?: boolean;
}

export const createSite = defineTool<CreateSiteResult>()({
  name: "nxis_create_site",
  description:
    "Create a site in this organization. Give the site's root URL. The host is fixed at creation — a site " +
    "created against the wrong domain has to be deleted rather than edited, so confirm the URL with the user " +
    "rather than inferring it.",
  input: z.strictObject({
    url: z.string().describe("Root URL, e.g. https://example.com"),
  }),
  surface: "provisioning",
  readOnly: false,
  hints: { destructive: false, idempotent: false, openWorld: false },
});

/** `nxis_verify_site`. `token` mode returns the tag; `check` mode, whether it was found. */
export interface VerifySiteResult extends Open, Next {
  mode?: "token" | "check";
  meta_tag?: string;
  token?: string;
  verified?: boolean;
  /** `check` mode, when not verified: `tag_not_found`, or `site_unreachable` when the page could not be fetched. */
  reason?: string;
  url?: string;
}

export const verifySite = defineTool<VerifySiteResult>()({
  name: "nxis_verify_site",
  description:
    "Prove ownership of a site. `token` returns a META tag to add to the site's HTML head — it must then be " +
    "deployed to the live site. `check` looks for it. A failed check almost always means the deploy has not " +
    "landed yet rather than that anything is wrong.",
  input: z.strictObject({
    mode: z.enum(["token", "check"]).describe("token = get the tag. check = verify it is live."),
    site,
    url: z.string().describe("Site URL. Defaults to the site's own domain.").optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  // `check` marks the site verified when the tag is found, so only `token` is a read.
  readOnly: (input) => input.mode === "token",
  // `check` fetches the live site.
  hints: { destructive: false, idempotent: true, openWorld: true },
});

/** `nxis_site_tag`. */
export interface SiteTagResult extends Open, Next {
  mode?: "status" | "issue";
  exists?: boolean;
  changed?: boolean;
  issued?: boolean;
  /** `site_not_verified` when `issue` was refused. */
  reason?: string;
  token?: string;
  script_tag?: string;
  claims?: {
    site_id?: string;
    webmcp_mode?: string;
    domains?: string[];
    expires_at?: string;
    issued_at?: string;
  };
}

export const siteTag = defineTool<SiteTagResult>()({
  name: "nxis_site_tag",
  description:
    "Issue or read the NxisAI site tag token for a VERIFIED site. `status` returns the current token and its " +
    "decoded claims. `issue` signs one for the given hosts with WebMCP mode `browser` unless told otherwise; the " +
    "site's own host is always included. Scheme and port are ignored — `localhost` covers every local port. " +
    "Re-issuing does not break the live tag: the previous token stays valid until it expires.",
  input: z.strictObject({
    mode: z.enum(["status", "issue"]).describe("status = read the current token. issue = sign one."),
    site,
    domains: z
      .array(z.string())
      .describe(
        'issue only. Hosts or URLs the tag may run on, e.g. ["example.com", "localhost"]. The site\'s own host ' +
          "is always added.",
      )
      .optional(),
    webmcp_mode: z.enum(["browser", "ssr", "none"]).describe("issue only. Defaults to browser.").optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: (input) => input.mode === "status",
  // `issue` signs a new token each time; the previous one stays valid until it expires.
  hints: { destructive: false, idempotent: false, openWorld: false },
});

/** `nxis_set_site_name`. */
export interface SetSiteNameResult extends Open, Next {
  display_name?: string;
}

export const setSiteName = defineTool<SetSiteNameResult>()({
  name: "nxis_set_site_name",
  description:
    "Set the site's display name: the title its MCP server card shows, and the name it is listed under in the " +
    "NxisAI app for Claude and ChatGPT. Use the business's or site's own name, as people would search for it.",
  input: z.strictObject({
    site,
    display_name: z.string().describe("1 to 80 characters."),
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
});

/** How the NxisAI app would list a site. */
export interface AppListing extends Open {
  title?: string;
  description?: string;
  verticals?: string[];
  places?: string[];
  capabilities?: string[];
  public?: boolean;
  discovery_files_link_card?: boolean;
}

/** `nxis_list_in_app`. */
export interface ListInAppResult extends Open {
  listed_in_app?: boolean;
  domain?: string;
  actionable_in_app?: boolean;
  /** How many WebSite drafts listing published, when it published any. */
  website_published?: number;
  as_listed?: AppListing;
  /** What still stands between the site and people using it in the app. */
  next?: string[];
}

export const listInApp = defineTool<ListInAppResult>()({
  name: "nxis_list_in_app",
  description:
    "List the site in the NxisAI app for Claude and ChatGPT, where people can find it, browse its records and " +
    "act on it. Off until the site owner turns it on. Listing it publishes the site's WebSite, the name and " +
    "description its home page gives, which the app shows on its card. Pass listed false to remove it, or " +
    "preview true to see how the app would list it (title, description, places, verticals, capabilities) " +
    "without changing anything.",
  input: z.strictObject({
    site,
    listed: z.boolean().describe("Defaults to true.").optional(),
    preview: z.boolean().describe("Report how the app would list the site, and change nothing.").optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: (input) => input.preview === true,
  // Listing publishes the site's WebSite and shows it in the app; unlisting removes it.
  hints: { destructive: true, idempotent: true, openWorld: false },
});

// ── data ────────────────────────────────────────────────────────────────────

/** `nxis_crawl_sitemap`. `found` and `done` are only on `status`. */
export interface CrawlSitemapResult extends Open {
  record?: string;
  sitemap?: string;
  /** The crawl's state, e.g. `COMPLETE` or `FAILED`. */
  state?: string;
  is_sitemap_index?: boolean;
  error?: string;
  /** `status`: false when the site has no crawl for that URL. */
  found?: boolean;
  /** `status`: the crawl finished, either way. */
  done?: boolean;
  note?: string;
}

export const crawlSitemap = defineTool<CrawlSitemapResult>()({
  name: "nxis_crawl_sitemap",
  description:
    "Crawl a sitemap into this site's resources. `submit` queues it and returns immediately; `status` reports " +
    "the crawl's state for the same URL. Crawling runs in the background, so poll `status` until it reaches " +
    "COMPLETE before doing anything that counts resources.",
  input: z.strictObject({
    url: z.string().describe("Sitemap URL. The site's own, or a generated one."),
    mode: z
      .enum(["submit", "status"])
      .describe("submit queues the crawl, status reports it. Defaults to submit.")
      .optional(),
    site,
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: (input) => input.mode === "status",
  // `submit` fetches the sitemap, wherever it is hosted, and queues another crawl each time.
  hints: { destructive: false, idempotent: false, openWorld: true },
});

/** `nxis_bulk_autofill`. Which fields are present depends on `mode`. */
export interface BulkAutofillResult extends Open {
  mode?: "plan" | "submit" | "status";
  // plan
  media_type?: string;
  pattern?: string;
  resource_count?: number;
  pattern_count?: number;
  site_total?: number;
  by_media?: Array<{ media_type?: string; count?: number }>;
  credit_limit?: number;
  credits_used_this_month?: number;
  credits_remaining?: number;
  existing?: "generate" | "import" | "import_and_complete";
  /** Only for a pure `import`, whose price per page is fixed. */
  import_cost_per_resource_milli?: number;
  quota_exceeded?: boolean;
  // submit
  /** False when a batch was already running (its id is reported) or nothing started. */
  started?: boolean;
  batch_id?: string;
  job_count?: number;
  // status
  found?: boolean;
  /** e.g. `RUNNING`, `PAUSED` (credits ran out; not terminal), `COMPLETE`, `FAILED`, `CANCELLED`. */
  status?: string;
  total?: number;
  done?: number;
  failed?: number;
  terminal?: boolean;
  /** `status` with no `batch_id`: the site's latest batches, newest first. */
  batches?: RecentBatch[];
  note?: string;
}

/** One of the latest batches `status` lists when no `batch_id` is given. */
export interface RecentBatch extends Open {
  batch_id?: string | null;
  status?: string;
  total?: number;
  done?: number;
  failed?: number;
  terminal?: boolean;
  /** ISO-8601. Absent for a batch that has not started; those are listed last. */
  started_at?: string | null;
}

export const bulkAutofill = defineTool<BulkAutofillResult>()({
  name: "nxis_bulk_autofill",
  description:
    "Bulk-generate structured data across many resources. `plan` reports how many resources match and the " +
    "organization's remaining credit balance, and writes nothing — use it to get consent before spending. " +
    "`submit` starts the batch. `status` reports progress for a batch_id; with no batch_id it lists the site's " +
    "latest batches, newest first, so if a `submit` response was lost call `status` with no batch_id to find the " +
    "batch rather than submitting again. Set `existing` to `import` when the site already publishes JSON-LD " +
    "(WordPress with Yoast or Rank Math, Shopify, most headless builds): its own structured data is brought in " +
    "with no AI, at a flat rate per page, instead of being generated.",
  input: z.strictObject({
    mode: z
      .enum(["plan", "submit", "status"])
      .describe(
        "plan = count and price it, changing nothing. submit = start the batch. status = check a batch, or list " +
          "the latest batches when batch_id is omitted.",
      ),
    media_type: z
      .enum(["HTML", "IMAGE", "VIDEO", "AUDIO"])
      .describe("Restrict to one media type. Must be the exact upper-case name.")
      .optional(),
    pattern: z.string().describe("Restrict to a URL path cluster, e.g. /products/*").optional(),
    site: z.string().describe("Site id. Required on the provisioning endpoint, rejected elsewhere.").optional(),
    batch_id: z
      .string()
      .describe(
        "The batch to check with status. Omit it to list the site's latest batches, e.g. after a lost submit response.",
      )
      .optional(),
    autofill_mode: z
      .string()
      .describe("What to generate, e.g. IMAGE_METADATA for deterministic ImageObject records.")
      .optional(),
    partial_ok: z
      .boolean()
      .describe("Allow the batch to proceed when some selections cannot be expanded.")
      .optional(),
    only_without_entities: z.boolean().describe("Skip resources that already have structured data.").optional(),
    existing: z
      .enum(["generate", "import", "import_and_complete"])
      .describe(
        "generate (default): AI writes the structured data. import: bring in the JSON-LD each page already " +
          "publishes, with no AI, at a flat rate per page; pages that publish none finish with nothing to import. " +
          "import_and_complete: import, then let AI generate only what each page lacks; a page with none is " +
          "generated in full. Imported data is available to agents and not added to the page again.",
      )
      .optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  // `submit` spends credits. `plan` and `status` change nothing.
  readOnly: (input) => input.mode !== "submit",
  // `submit` spends credits and starts a batch each time; it reads the site's pages.
  hints: { destructive: true, idempotent: false, openWorld: true },
});

/** `nxis_publish_entities`. */
export interface PublishEntitiesResult extends Open {
  dry_run?: boolean;
  schema_type?: string;
  published_count?: number;
  already_published_count?: number;
  skipped_disabled_count?: number;
  note?: string;
}

export const publishEntities = defineTool<PublishEntitiesResult>()({
  name: "nxis_publish_entities",
  description:
    "Publish this site's draft structured data so it is served. Scope with `schema_type` (e.g. ImageObject) or " +
    "omit it to publish every type. Set dry_run to count what would publish without changing anything. " +
    "Generated data starts in a disabled state, so this is what makes it live.",
  input: z.strictObject({
    schema_type: z
      .string()
      .describe("schema.org type to publish, e.g. ImageObject or Product. Omit to publish every type.")
      .optional(),
    dry_run: z.boolean().describe("Count what would publish and write nothing.").optional(),
    site,
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: (input) => input.dry_run === true,
  // Makes draft data live.
  hints: { destructive: true, idempotent: true, openWorld: false },
});

// ── MCP, actions and discovery ──────────────────────────────────────────────

/** `nxis_enable_public_mcp`. */
export interface EnablePublicMcpResult extends Open {
  is_public?: boolean;
  domain?: string;
  /** The site's own MCP URL, `https://<domain>/mcp`. */
  endpoint?: string;
}

export const enablePublicMcp = defineTool<EnablePublicMcpResult>()({
  name: "nxis_enable_public_mcp",
  description:
    "Turn the site's MCP server on so agents can query its structured data without a key. This is what makes " +
    "everything else in setup useful. Pass enabled false to turn it off again.",
  input: z.strictObject({
    site,
    enabled: z.boolean().describe("Defaults to true.").optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: false,
  // Turning it on lets anyone query the site's data without a key.
  hints: { destructive: true, idempotent: true, openWorld: false },
});

/** `nxis_on_page_agent`. */
export interface OnPageAgentResult extends Open {
  on_page_agent?: boolean;
  domain?: string;
  next?: string[];
}

export const onPageAgent = defineTool<OnPageAgentResult>()({
  name: "nxis_on_page_agent",
  description:
    "Say that the site's pages run the NxisAI agent (@nxisai/agent-harness), so links to a page with a form open " +
    "the agent on that form. Turn it on only once the agent loads on the site's production pages. Pass enabled " +
    "false to turn it off.",
  input: z.strictObject({
    site,
    enabled: z.boolean().describe("Defaults to true.").optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: false,
  hints: { destructive: true, idempotent: true, openWorld: false },
});

/** Where one action's submissions go. Secrets are never included; a webhook's is previewed. */
export interface ActionRoute extends Open {
  route?: "browser" | "webhook" | "gateway" | "ucp" | "unset";
  url?: string;
  method?: "POST" | "PUT";
  signing_secret_preview?: string;
  provider?: string;
}

/** `nxis_mcp_settings`, and the settings part of `nxis_bind_mcp_action`. */
export interface McpSettingsResult extends Open {
  /** False on a site whose MCP server was never set up: the rest are the defaults, and nothing exists yet. */
  configured?: boolean;
  domain?: string;
  /** The site's own MCP URL, `https://<domain>/mcp`. */
  endpoint?: string;
  enabled?: boolean;
  is_public?: boolean;
  listed_in_app?: boolean;
  on_page_agent?: boolean;
  api_key_preview?: string;
  actions_enabled?: boolean;
  default_route?: ActionRoute;
  /** By action name, e.g. `reserve`. */
  overrides?: Record<string, ActionRoute>;
}

export const mcpSettings = defineTool<McpSettingsResult>()({
  name: "nxis_mcp_settings",
  description:
    "Read this site's MCP configuration: whether the server is enabled and public, whether action tools are " +
    "generated, and where each action's submissions are routed. Read-only — use it before changing anything, " +
    "and to confirm a change afterwards. It creates nothing: on a site that has never been set up it reports " +
    "the defaults with configured false.",
  input: z.strictObject({ site }),
  surface: "provisioning",
  takesSite: true,
  readOnly: true,
  hints: { openWorld: false },
});

/** The action names `nxis_bind_mcp_action` routes, in the server's order. */
export const ACTION_NAMES = ["apply", "ask", "buy", "donate", "order", "pay", "quote", "reserve", "schedule"] as const;

/**
 * `nxis_bind_mcp_action`: the new settings, or `changed: false` and what is needed first.
 *
 * @remarks
 * `signing_secret` is a webhook's new raw secret, sent once, when the binding is created. Do not
 * log it; show it once, as the server's `next` says.
 *
 * Sent `enabled` alone, the tool switches actions without touching the routes: `changed` says
 * whether it wrote, `configured: false` that the site has no MCP settings, and a `next` that it
 * refused (turning on with nothing bound).
 */
export interface BindMcpActionResult extends McpSettingsResult {
  changed?: boolean;
  configured?: boolean;
  next?: string;
  note?: string;
  signing_secret?: string;
  secret_is_new?: boolean;
}

export const bindMcpAction = defineTool<BindMcpActionResult>()({
  name: "nxis_bind_mcp_action",
  description:
    "Expose the site's actions — booking, quote requests, sign-ups — as MCP write tools, and choose where their " +
    "submissions go. Defaults to the page that hosts the action, which needs no configuration. Route elsewhere " +
    "only when the user has told you where: never invent a destination. Call nxis_mcp_settings first to see the " +
    "current routing. To pause actions or turn them back on, send only enabled, with no route: the routes are " +
    "kept as they are.",
  input: z.strictObject({
    site,
    enabled: z
      .boolean()
      .describe(
        "Defaults to true. False stops generating action tools. Sent without route, it only turns actions off or " +
          "on and keeps every route, override and webhook secret as it is; turning on that way needs a route " +
          "bound already.",
      )
      .optional(),
    route: z
      .enum(["browser", "webhook", "gateway"])
      .describe(
        "Where submissions go. 'browser' runs the action on the page that declares it and needs nothing else. " +
          "'webhook' posts to a URL the user gives you. 'gateway' is configured in the dashboard. Defaults to " +
          "'browser' when enabled is not sent; with enabled alone, the routes are left as they are.",
      )
      .optional(),
    webhook_url: z
      .string()
      .describe(
        "Required when route is 'webhook'. Must be a URL the user named — ask for it rather than guessing. It " +
          "does not have to be on the site's own domain.",
      )
      .optional(),
    action: z
      .enum(ACTION_NAMES)
      .describe("Route only this kind of action, leaving the rest on the default. Omit to set the default.")
      .optional(),
  }),
  surface: "provisioning",
  takesSite: true,
  readOnly: false,
  // Replaces where submissions go; `webhook` posts them to any URL, and may issue a new secret.
  hints: { destructive: true, idempotent: false, openWorld: true },
});

/** One discovery document and the path, under the site's public root, it belongs at. */
export interface DiscoveryDocument {
  path: string;
  content: string;
}

/** `nxis_aio_files`. */
export interface AioFilesResult extends Open {
  site?: string;
  mcp_endpoint?: string;
  documents?: DiscoveryDocument[];
  note?: string;
}

export const aioFiles = defineTool<AioFilesResult>()({
  name: "nxis_aio_files",
  description:
    "The AI discovery documents for this site — llms.txt, agents.md, ai-catalog.json and mcp/catalog.json — with " +
    "the path each belongs at. Write them into the site's public root and deploy. Merge rather than overwrite if " +
    "any already exist.",
  input: z.strictObject({ site }),
  surface: "provisioning",
  takesSite: true,
  readOnly: true,
  hints: { openWorld: false },
});
