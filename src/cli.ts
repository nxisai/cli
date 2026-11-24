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
import { offerSignIn } from "./guided/sign-in.js";
import { checkFlags } from "./command-flags.js";
import { HELP } from "./help.js";


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
export async function main(argv: string[], retried = false): Promise<number> {
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
  let signInCtx: Ctx | undefined;

  try {
    // Before anything is read, saved or sent: a flag the command doesn't take is a typo, or a
    // flag from a newer release, and running without it would do something else.
    checkFlags(positional, flags);
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
    signInCtx = ctx;

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
        // With no plan named, a terminal offers the choice; anywhere else it stops with `missing_tier`.
        await cmdSubscribe(ctx, {
          ...(sub ? { tier: sub } : {}),
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
    // On a terminal, a command that needs a sign-in offers one, then runs again, once.
    if (!retried && signInCtx) {
      const signedIn = await offerSignIn(signInCtx, err, [command, sub], bool(flags, "yes")).catch((e: unknown) => e);
      if (signedIn === true) return main(argv, true);
      if (signedIn instanceof Error) return report(signedIn, json);
    }
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
