/**
 * The `--help` text.
 *
 * @remarks
 * Every flag a command takes is on that command's lines, and the global flags are under
 * Options: a test reads this text against the command table in `./command-flags.ts`, both ways.
 */

export const HELP = `nxis — set up NxisAI from the terminal

Usage
  nxis <command> [options]

Getting set up
  signup [--name <name>] [--website <url>] [--dev]
                             Sign in, create an organization, and choose a plan (a terminal
                             offers the plans; --json lists them)
  login [--web]              Sign in with Google (device code; --web uses a browser redirect)
  status                     Where you are in setup — safe to run any time
  plans [--dev]              Plans available to buy; --dev lists an environment's development plans
  subscribe [<tier>]         Activate a free plan, or pay for a paid one; with no tier, a
                             terminal offers the plans to choose from
  credits                    Credit balance
  credits packs              Buyable credit packs
  credits buy <sku>          Buy a top-up (needs an active plan first)
  mcp install [--stdio] [--agent claude-code|cursor|mcp-json] [--force] [--print]
              [--read-only] [--allow-unconfirmed]
                             Wire the onboarding tools into your agent, as a local
                             server (\`nxis mcp serve\`) with no key in its config. --agent
                             picks the agent (default: detected), --force replaces an existing
                             entry, --print prints the config instead of installing it, and
                             --read-only and --allow-unconfirmed go to the server it installs
  mcp install --remote       Instead, create an MCP key and wire in the remote endpoint
  mcp serve [--read-only] [--allow-unconfirmed]
                             Run the onboarding tools as a local MCP server on stdio; asks
                             you, through your agent, before a call that spends credits or
                             goes public, and shows you the sign-in, plan, credits, agreement
                             and scope choices there. --read-only refuses every call that may
                             change something; --allow-unconfirmed runs risky calls on the
                             agent's own approval when it can't ask you

Site data
  crawl submit [<sitemap-url>] [--wait]
                             Check the sitemap names the site's host, then crawl it
  crawl status [<sitemap-url>] [--wait]
  autofill plan [--existing import_and_complete|import|generate]
                [--media-type HTML|IMAGE|VIDEO|AUDIO] [--pattern <path>]
                             Count what structured data would cover; changes nothing
  autofill submit [--existing …] [--media-type …] [--pattern <path>] [--yes] [--wait]
                             Generate it — spends credits, asks first, submits once; with no
                             scope, a terminal offers the site's path clusters, and with too few
                             credits, the packs
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
                             --supports-check: the receiver answers availability checks, so
                             agents check first (Booking's open times, Quote's service area).
                             --availability-url, Booking only: where free times are read (an
                             empty value clears it)
  actions on|off             Turn the site's action tools on or off, keeping every route
  connections list           The site's connections: name, address, secret preview, who uses each
  connections create --name <name> --url <url> [--default] [--write-env <file> [--env-name <var>]]
                             A named address for agents and actions to send to; its signing
                             secret is shown once. --default makes it the site's default.
                             --write-env writes the secret into that env file (git must ignore
                             it) as NXIS_ACTION_SECRET or --env-name, and doesn't show it
  connections rotate <name|id> [--yes] [--write-env <file> [--env-name <var>]]
                             A new signing secret, shown once (or written with --write-env);
                             the old one stops working. Asks first
  connections delete <name|id> [--yes]
                             Delete one nothing uses any more. Asks first
  connections test <name|id> [--action <type>] [--turn-on-checks]
                             Send one signed check call from NxisAI to its address, and say how
                             the receiver answered: ok, signature_rejected, unreachable, timeout
                             or bad_response, whether it answers availability checks, and the
                             next step. --action quote|booking|… picks the example's action.
                             When it answers checks, --turn-on-checks turns check support on for
                             the routes that have it off (on a terminal it asks). Commits
                             nothing. Exit 2 unless ok
  discovery files [--write] [--out <dir>]
                             Print llms.txt, agents.md and the AI catalogs; --write merges them
                             into public/ or static/ (or --out), showing a diff, never overwriting
  types [--limit n]          The types the site's MCP server serves, with counts
  query <type> [--text <q>] [--filter path=op:value …] [--limit n] [--exact]
               [--page-token <t>]
                             Typed records; --text is a semantic search, billed to the organization.
                             --exact leaves out the type's subtypes; --page-token reads the next page

Organizations
  orgs create --name <name> [--website <url>] [--industry <text>]
  orgs list
  orgs use <org-id|name>
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
            [--domain <host>]... [--webmcp-mode browser|ssr|none]
                                        issue only: more hosts it may run on, and how WebMCP runs

Site keys (for software on the site's own server that needs one narrow write)
  keys create --scope content_gaps:report
                             A key for the current site that can only report its content gaps;
                             shown once
  keys list [--all]          The current site's keys you created; --all includes revoked ones
  keys revoke <key-id>       Revoke a key; it stops working on its next use

Hosted agents (by catalog id: page, support, quote, booking ...; changes reach the site within seconds)
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
  agents catalog [--job <job>]... [--industry <name>]... [--readiness <r>]...
                 [--added|--not-added] [--query <words>] [--by-fit]
                             The agents NxisAI offers: fit, readiness, whether NxisAI hosts it,
                             whether the site has it, and what it still needs
  agents catalog <id>        One agent: its settings as flags with their limits, what it needs,
                             and the enable line that works
  agents enable <id> [--<setting> <value>]... [--connection <name|id>]
                             Turn an agent on (page, support, quote, booking ...), with any of its
                             settings: page|support take --label, --description, --example
                             (repeats, replaces the list) and --model, as \`agents catalog <id>\`
                             lists. --connection routes its requests (Quote, Booking); exit 2
                             connection_required lists the site's connections. A terminal first
                             offers the data processing agreement when the agents wait on it
  agents configure <id> [--<setting> <value>]... [--clear <setting>]...
                             Change an agent's settings without turning it on or off
  agents disable <id>        Turn an agent off, keeping its settings
  agents pause [<id>] [--tools] [--reason <text>]
                             Kill switch: refuse every turn, or with --tools only actions
                             (tools that change something); --reason is what visitors are told. Names one
                             agent, or with none, every hosted agent on the site
  agents resume [<id>]       Turn that agent's pause off, or with none, the site-wide one
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
  agents transcripts webhook remove|status
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
  --profile <name>           A name for the environment --api points at, shown by \`nxis status\`
  --no-open                  Print payment links instead of opening a browser
  --timeout <minutes>        How long to wait for a payment (default 15), a crawl (30) or a batch (60)
  --yes                      Skip the confirmation (autofill submit, publish, agents transcripts delete,
                             agents dpa accept), and ask nothing else: without it, a terminal offers
                             to sign in, buy credits, pick the pages a batch covers, or accept the
                             agreement, when a command needs it
  --help                     This text
  --version                  The version of nxis

A flag the command doesn't take is refused (exit 1, unknown_flag) before anything is sent, with
the flags it does take, closest first.

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
