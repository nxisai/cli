#!/usr/bin/env node
/**
 * Argument parsing and dispatch.
 *
 * @remarks
 * `npx -y @nxisai/cli` should cost one small download, because an agent invoking this cold is
 * the common case and every dependency is latency in front of a user who is waiting. So the
 * parser is hand-rolled (`./args.ts`), and the only runtime dependencies are the MCP SDK and its
 * schema library, `zod`, which the provisioning commands need to speak MCP.
 */

import { cmdLogin } from "./commands/login.js";
import { cmdLogout, cmdWhoami } from "./commands/account.js";
import { cmdStatus } from "./commands/status.js";
import { cmdPlans } from "./commands/plans.js";
import { cmdOrgsCreate, cmdOrgsList, cmdOrgsUpdate, cmdOrgsUse } from "./commands/orgs.js";
import { cmdSubscribe } from "./commands/subscribe.js";
import { cmdCredits, cmdCreditsBuy, cmdCreditsPacks } from "./commands/credits.js";
import { cmdMcpInstall, serveFlagsFrom } from "./commands/mcp.js";
import { mcpSiteCommand } from "./commands/mcp-site.js";
import { cmdActionsBind, cmdActionsSwitch } from "./commands/actions.js";
import { runConnections, supportsCheckFlag } from "./commands/connections.js";
import { cmdDiscoveryFiles } from "./commands/discovery.js";
import { cmdQuery, cmdTypes } from "./commands/reads.js";
import { cmdSignup } from "./commands/signup.js";
import { runKeys } from "./commands/keys.js";
import { runHostedAgents } from "./commands/hosted-agents.js";
import { runSites } from "./commands/sites.js";
import { crawl } from "./commands/crawl.js";
import { autofill } from "./commands/autofill.js";
import { publish } from "./commands/publish.js";
import { cmdUpdate } from "./commands/update.js";
import { bool, list, num, parseArgs, str, type Parsed } from "./args.js";
import { PRODUCTION_API, resolveConfig } from "./config.js";
import type { Ctx } from "./context.js";
import { CliError, ExitCode } from "./errors.js";
import { createIo } from "./output.js";
import { loadSettings, updateSettings } from "./state.js";
import { packageVersion } from "./self.js";
import { setTrace } from "./trace.js";

/** The `--help` text. */
const HELP = `nxis — set up NxisAI from the terminal

Usage
  nxis <command> [options]

Getting set up
  signup                     Sign in, create an organization, and list plans
  login [--web]              Sign in with Google (device code; --web uses a browser redirect)
  status                     Where you are in setup — safe to run any time
  plans                      Plans available to buy
  subscribe <tier>           Activate a free plan, or pay for a paid one
  credits                    Credit balance
  credits packs              Buyable credit packs
  credits buy <sku>          Buy a top-up (needs an active plan first)
  mcp install                Wire the onboarding tools into your agent, as a local
                             server (\`nxis mcp serve\`) with no key in its config
  mcp install --remote       Instead, create an MCP key and wire in the remote endpoint
  mcp serve                  Run the onboarding tools as a local MCP server on stdio; asks
                             you, through your agent, before a call that spends credits or
                             goes public

Site data
  crawl submit [<sitemap-url>] [--wait]
                             Check the sitemap names the site's host, then crawl it
  crawl status [<sitemap-url>] [--wait]
  autofill plan [--existing import_and_complete|import|generate]
                [--media-type HTML|IMAGE|VIDEO|AUDIO] [--pattern <path>]
                             Count what structured data would cover; changes nothing
  autofill submit [same options] [--yes] [--wait]
                             Generate it — spends credits, asks first, submits once
  autofill status [--batch <id>] [--wait] [--recent]
                             Follow a batch; --recent lists the site's latest batches
  publish [--dry-run] [--type <schema-type>] [--yes]
                             Make generated data live — asks first (--dry-run counts it)

Your site's MCP server, actions and discovery
  mcp public on|off          Make the site's MCP server public, or not; prints its endpoint
  mcp settings [--set key=value …]
                             Show the MCP settings, or change public, listed_in_app, on_page_agent
  actions bind <action|booking|default> --connection <name|id>
               | --webhook <url> | --gateway | --self-page
                             Route an action's submissions (reserve, quote, …, the Booking agent,
                             or every action). --webhook reuses the connection with that address,
                             or creates one named from its host
               [--supports-check[=false]] [--availability-url <url>]
                             Booking only: check availability before booking, and where free
                             times are read (an empty value clears it)
  actions on|off             Turn the site's action tools on or off, keeping every route
  connections list           The site's connections: name, address, secret preview, who uses each
  connections create --name <name> --url <url> [--default]
                             A named address for agents and actions to send to; its signing
                             secret is shown once. --default makes it the site's default
  connections rotate <name|id> [--yes]
                             A new signing secret, shown once; the old one stops working. Asks first
  connections delete <name|id> [--yes]
                             Delete one nothing uses any more. Asks first
  discovery files [--write] [--out <dir>]
                             Print llms.txt, agents.md and the AI catalogs; --write merges them
                             into public/ or static/ (or --out), showing a diff, never overwriting
  types                      The types the site's MCP server serves, with counts
  query <type> [--text <q>] [--filter path=op:value …] [--limit n]
                             Typed records; --text is a semantic search, billed to the organization

Organizations
  orgs create --name <name> [--website <url>]
  orgs list
  orgs use <org-id>
  orgs update [--name <name>] [--website <url>] [--industry <text>]

Sites (the site steps of the Site Onboarding skill)
  sites create <url> [--name <name>]    Step 1: create the site and make it current
  sites list                            The organization's sites; * marks the current one
  sites use <id|domain>                 Pick the site the other commands act on
  sites verify --token                  Step 2: the META tag to deploy to production
  sites verify --check                  Step 3: check the tag is live (exit 2 until it is)
  sites name <name>                     Step 9: the name the NxisAI app lists it under
  sites list-in-app [--preview] [--off] Step 9: list it in the NxisAI app (--preview changes nothing)
  sites tag [status|issue]              After onboarding: the site tag, for a verified site

Site keys (for software on the site's own server that needs one narrow write)
  keys create --scope content_gaps:report
                             A key for the current site that can only report its content gaps;
                             shown once
  keys list [--all]          The current site's keys you created; --all includes revoked ones
  keys revoke <key-id>       Revoke a key; it stops working on its next use

Hosted agents (the on-page assistant and the Support Agent; changes reach the site within seconds)
  agents status              What runs on the current site: each agent, the chat's branding, the
                             kill switch, the policy version, the verified hosts, what holds
                             back going live, and any notices
  agents dpa                 The data processing agreement going live needs: its current
                             version, where to read it, and who accepted it and when
  agents dpa accept [--yes]  Accept the current version for your organization, covering all of
                             its sites, after showing it and its link; asks first (exit 2 with no
                             terminal, until --yes says the user agreed)
  agents dpa accept --site <id> --entity <name>
                             Accept it for a site that belongs to a different legal entity than
                             your organization: that entity accepts, for that site only
  agents enable page|support [--label <text>] [--description <text>] [--example <q>]...
                [--model <id>]
                             Turn an agent on; the Support Agent needs a label. --example
                             repeats, and replaces the example questions
  agents disable page|support
                             Turn an agent off, keeping its settings
  agents pause [page|support] [--tools] [--reason <text>]
                             Kill switch: refuse every turn, or with --tools only actions
                             (tools that change something); --reason is what visitors are told. Names one
                             agent, or with none, every hosted agent on the site
  agents resume [page|support]
                             Turn that agent's pause off, or with none, the site-wide one
  agents brand [--name <text>] [--logo <https url>] [--accent <#rrggbb>]
               [--privacy-url <https url>] [--clear name|logo|accent|privacy-url]...
                             The chat's look on the site: the name visitors see (at most 60
                             characters), the logo, the accent color (#rgb or #rrggbb) and the
                             privacy page; only the parts given change, --clear resets one
  agents policy set <file.json | ->
                             Replace the guardrails policy document (\`-\` reads stdin). The
                             hosted agents follow NxisAI's instructions, so it can't set
                             "systemPrompt"
  agents policy show [--instructions]
                             The policy document as stored, and the version of NxisAI's
                             instructions the on-page assistant follows; --instructions
                             prints them in full
  agents transcripts list [--limit <n>] [--page-token <t>]
                             The site's stored conversations, newest first
  agents transcripts show <id>
                             One conversation, every message in order
  agents transcripts export [--out <file>] [--format json|csv] [--force]
                             Every conversation with its messages, every page; stdout without --out
  agents transcripts delete <id> | --all [--yes]
                             Delete one conversation, or every one; asks first, cannot be undone
  agents transcripts settings [--retention-days <n>] [--dont-store | --store]
                             How long conversations are kept (1 to 3650 days), or none stored
  agents transcripts webhook set <url> [--keep-secret]
                             Send each message to a URL, signed with a new secret shown once;
                             --keep-secret changes the URL only
  agents transcripts webhook remove | status
                             Remove the webhook and its secret, or show how deliveries are going

Other
  whoami                     Who is signed in
  logout                     Forget stored credentials
  update [--check] [--to <version>] [--from <dir>]
                             Update nxis: in place when the installer put it there (signed
                             releases only), else the command that updates it

Options
  --json                     Machine-readable output, one object on stdout
  --verbose                  Print every request before it is sent, secrets removed
  --dry-run                  Show what would be sent, without changing anything
  --api <url>                Point at another NxisAI environment
  --org <id>                 Act on this organization instead of the saved one
  --site <id|domain>         Act on this site instead of the saved one
  --no-open                  Print payment links instead of opening a browser
  --timeout <minutes>        How long to wait for a payment (default 15), a crawl (30) or a batch (60)
  --yes                      Skip the confirmation (autofill submit, publish, agents transcripts delete,
                             agents dpa accept)
  --agent <name>             mcp install: claude-code, cursor or mcp-json (default: detected)
  --scope <scope>            keys create: what the key may do (content_gaps:report)
  --force                    Replace an existing MCP server entry
  --print                    Print the MCP config instead of installing it
  --read-only                mcp serve (and install): refuse every call that may change something
  --allow-unconfirmed        mcp serve (and install): when the agent can't ask you, run risky calls
                             on its own approval instead of refusing them

Environment
  NXIS_API                   Base URL for every service, same as --api
  NXIS_TOKEN                 Use this access token instead of signing in
  NXIS_SITES_URL             Base URL for the sites service (hosted agent settings)
  NXIS_DPA_URL               Where the data processing agreement is published (default
                             https://nxis.ai/dpa; each version at <url>/<version>)
  NXIS_NO_BROWSER=1          Print URLs instead of opening a browser
  NXIS_NO_KEYCHAIN=1         Store credentials in a file instead of the OS keychain

Exit codes
  0  done     2  needs you (sign-in or payment pending)     3  not authorized     1  failed
`;

/**
 * Runs one CLI invocation.
 *
 * @remarks
 * An explicit `--api` is saved to the settings file, so later commands keep using the same
 * environment without repeating the flag.
 *
 * @param argv - Arguments after the executable and script path.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  // Before help: `nxis --version` has no command, and would otherwise get the help text.
  if (flags.has("version") || flags.has("v")) {
    process.stdout.write(`${packageVersion()}\n`);
    return ExitCode.OK;
  }
  if (flags.has("help") || flags.has("h") || positional.length === 0) {
    process.stdout.write(HELP);
    return ExitCode.OK;
  }

  const json = bool(flags, "json");
  const io = createIo(json);

  // Requests are printed to stderr, so --json still owns stdout.
  setTrace({ verbose: bool(flags, "verbose"), dryRun: bool(flags, "dry-run") });

  const [command, sub, third] = positional;

  try {
    const saved = loadSettings();
    const api = str(flags, "api");
    // Inside the try: resolving the configuration can reject a bad base URL, and that failure
    // has to reach `report` like any other, so `--json` still gets an object rather than a line
    // of prose on stderr.
    const config = resolveConfig({
      ...(api ? { api } : {}),
      ...(str(flags, "profile") ? { profile: str(flags, "profile") as string } : {}),
      saved,
    });

    if (api?.trim().toLowerCase() === PRODUCTION_API) {
      if (saved.api || saved.profile) updateSettings({ api: undefined, profile: undefined });
    } else if (api && api !== saved.api) {
      updateSettings({ api, profile: config.profile });
    } else if (!api && !process.env.NXIS_API?.trim() && saved.api) {
      // A saved base URL redirects every command, so it is never silent. On stderr, even with
      // --json, where an agent reading stdout is not disturbed by it but a person still sees it.
      process.stderr.write(
        `Using ${saved.api}, saved by an earlier --api. Run with --api production to go back.\n`,
      );
    }

    const ctx: Ctx = {
      config,
      io,
      ...(str(flags, "org") ? { orgOverride: str(flags, "org") as string } : {}),
      ...(str(flags, "site") ? { siteOverride: str(flags, "site") as string } : {}),
    };

    switch (command) {
      case "signup":
        await cmdSignup(ctx, {
          ...(str(flags, "name") ? { name: str(flags, "name") as string } : {}),
          ...(str(flags, "website") ? { website: str(flags, "website") as string } : {}),
          dev: bool(flags, "dev"),
        });
        break;

      case "login":
        await cmdLogin(ctx, { web: bool(flags, "web") });
        break;

      case "logout":
        await cmdLogout(ctx);
        break;

      case "whoami":
        await cmdWhoami(ctx);
        break;

      case "update":
        await cmdUpdate(ctx, {
          check: bool(flags, "check"),
          ...(str(flags, "to") ? { to: str(flags, "to") as string } : {}),
          ...(str(flags, "from") ? { from: str(flags, "from") as string } : {}),
        });
        break;

      case "status":
        await cmdStatus(ctx);
        break;

      case "plans":
        await cmdPlans(ctx, { dev: bool(flags, "dev") });
        break;

      case "orgs":
        await orgs(ctx, sub, third, flags);
        break;

      case "subscribe": {
        if (!sub) throw new CliError("Which plan? Try `nxis plans` first.", { reason: "missing_tier" });
        await cmdSubscribe(ctx, {
          tier: sub,
          noOpen: bool(flags, "no-open"),
          ...(num(flags, "timeout") !== undefined ? { timeoutMinutes: num(flags, "timeout") as number } : {}),
        });
        break;
      }

      case "credits":
        await credits(ctx, sub, third, flags);
        break;

      case "sites":
        await runSites(ctx, positional.slice(1), flags);
        break;

      case "keys":
        await runKeys(ctx, positional.slice(1), flags);
        break;

      case "agents":
        await runHostedAgents(ctx, positional.slice(1), flags);
        break;

      case "mcp": {
        if (sub === "serve") {
          // Loaded here, so other commands don't load the MCP server.
          const { cmdMcpServe } = await import("./commands/mcp-serve.js");
          await cmdMcpServe(ctx, { readOnly: bool(flags, "read-only"), allowUnconfirmed: bool(flags, "allow-unconfirmed") });
          break;
        }
        if (await mcpSiteCommand(ctx, sub, third, flags)) break;
        if (sub !== "install") {
          throw new CliError("Try `nxis mcp install`, `nxis mcp serve`, `nxis mcp public on|off` or `nxis mcp settings`.", { reason: "unknown_command" });
        }
        await cmdMcpInstall(ctx, {
          ...(str(flags, "agent") ? { agent: str(flags, "agent") as string } : {}),
          force: bool(flags, "force"),
          print: bool(flags, "print"),
          stdio: bool(flags, "stdio"),
          remote: bool(flags, "remote"),
          // Only what was given on this command line: saved settings are read when the server runs.
          serveFlags: serveFlagsFrom(flags),
        });
        break;
      }

      case "crawl":
        await crawl(ctx, positional.slice(1), flags);
        break;

      case "autofill":
        await autofill(ctx, positional.slice(1), flags);
        break;

      case "publish":
        await publish(ctx, positional.slice(1), flags);
        break;

      case "actions": {
        if (sub === "on" || sub === "off") {
          await cmdActionsSwitch(ctx, sub === "on");
          break;
        }
        if (sub !== "bind") {
          throw new CliError("Try `nxis actions bind <action|booking|default> …`, or `nxis actions on|off`.", {
            reason: "unknown_command",
          });
        }
        {
          const supportsCheck = supportsCheckFlag(flags);
          await cmdActionsBind(ctx, {
            ...(third ? { action: third } : {}),
            ...(str(flags, "connection") !== undefined ? { connection: str(flags, "connection") as string } : {}),
            ...(str(flags, "webhook") !== undefined ? { webhook: str(flags, "webhook") as string } : {}),
            gateway: bool(flags, "gateway"),
            selfPage: bool(flags, "self-page"),
            ...(supportsCheck !== undefined ? { supportsCheck } : {}),
            ...(str(flags, "availability-url") !== undefined ? { availabilityUrl: str(flags, "availability-url") as string } : {}),
          });
        }
        break;
      }

      case "connections":
        await runConnections(ctx, positional.slice(1), flags);
        break;

      case "discovery": {
        if (sub !== "files") throw new CliError("Try `nxis discovery files [--write]`.", { reason: "unknown_command" });
        await cmdDiscoveryFiles(ctx, {
          write: bool(flags, "write"),
          ...(str(flags, "out") ? { out: str(flags, "out") as string } : {}),
        });
        break;
      }

      case "types":
        await cmdTypes(ctx, num(flags, "limit") !== undefined ? { limit: num(flags, "limit") as number } : {});
        break;

      case "query":
        await cmdQuery(ctx, {
          ...(sub ? { type: sub } : {}),
          ...(str(flags, "text") ? { text: str(flags, "text") as string } : {}),
          filters: list(flags, "filter"),
          ...(num(flags, "limit") !== undefined ? { limit: num(flags, "limit") as number } : {}),
          exact: bool(flags, "exact"),
          ...(str(flags, "page-token") ? { pageToken: str(flags, "page-token") as string } : {}),
        });
        break;

      default:
        throw new CliError(`Unknown command "${command}". Run \`nxis --help\`.`, { reason: "unknown_command" });
    }
    return ExitCode.OK;
  } catch (err) {
    return report(err, json);
  }
}

/** Dispatches `nxis orgs <sub>`. */
async function orgs(ctx: Ctx, sub: string | undefined, third: string | undefined, flags: Parsed["flags"]): Promise<void> {
  switch (sub) {
    case "create":
      await cmdOrgsCreate(ctx, {
        ...(str(flags, "name") ? { name: str(flags, "name") as string } : {}),
        ...(str(flags, "website") ? { website: str(flags, "website") as string } : {}),
        ...(str(flags, "industry") ? { industry: str(flags, "industry") as string } : {}),
      });
      return;
    case "list":
      await cmdOrgsList(ctx);
      return;
    case "use":
      if (!third) throw new CliError("Which organization? `nxis orgs use <org-id>`.", { reason: "missing_org" });
      await cmdOrgsUse(ctx, third);
      return;
    case "update":
      await cmdOrgsUpdate(ctx, {
        ...(str(flags, "name") ? { name: str(flags, "name") as string } : {}),
        ...(str(flags, "website") ? { website: str(flags, "website") as string } : {}),
        ...(str(flags, "industry") ? { industry: str(flags, "industry") as string } : {}),
      });
      return;
    default:
      throw new CliError("Try `nxis orgs create|list|use|update`.", { reason: "unknown_command" });
  }
}

/** Dispatches `nxis credits [packs | buy <sku>]`. */
async function credits(ctx: Ctx, sub: string | undefined, third: string | undefined, flags: Parsed["flags"]): Promise<void> {
  if (!sub) {
    await cmdCredits(ctx);
    return;
  }
  if (sub === "packs") {
    await cmdCreditsPacks(ctx);
    return;
  }
  if (sub === "buy") {
    if (!third) throw new CliError("Which pack? `nxis credits packs` lists them.", { reason: "missing_sku" });
    await cmdCreditsBuy(ctx, {
      sku: third,
      noOpen: bool(flags, "no-open"),
      ...(num(flags, "timeout") !== undefined ? { timeoutMinutes: num(flags, "timeout") as number } : {}),
    });
    return;
  }
  throw new CliError("Try `nxis credits`, `nxis credits packs`, or `nxis credits buy <sku>`.", {
    reason: "unknown_command",
  });
}

/**
 * Reports a failure and maps it to an exit code.
 *
 * @remarks
 * One error shape for both audiences. Under --json the failure is an object on stdout with the
 * same `reason` an agent would branch on; otherwise it's a line on stderr.
 */
function report(err: unknown, json: boolean): number {
  const cliError = err instanceof CliError ? err : null;
  const message = cliError?.message ?? (err as Error)?.message ?? String(err);
  const code = cliError?.exitCode ?? ExitCode.ERROR;

  // A dry run did exactly what was asked, so it reports as a success. Saying `ok: false` would
  // tell an agent the command failed when nothing went wrong.
  if (cliError?.reason === "dry_run") {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...cliError.details }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return ExitCode.OK;
  }

  if (json) {
    const payload = cliError ? cliError.toJSON() : { ok: false, reason: "error", error: message };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  return code;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = ExitCode.ERROR;
  });
