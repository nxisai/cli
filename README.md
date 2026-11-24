# @nxisai/cli

Set up NxisAI from the terminal. Sign in, pick a plan, and hand your coding agent a working MCP
connection, without leaving the shell and without a key ever appearing in an agent transcript.

## What it does

An agent can do most of onboarding, but not all of it. Two steps belong to a person: signing in
and paying. Everything around them is mechanical. This CLI does the mechanical part and stops
cleanly at the two that aren't, in a way an agent can detect without seeing the browser.

- `nxis signup` signs you in, creates or reuses an organization, and lists available plans.
- `nxis subscribe` activates a free plan directly, or opens a Stripe payment page and waits.
- `nxis mcp install` wires NxisAI's onboarding tools into your agent, as a local MCP server
  (`nxis mcp serve`) that uses the CLI's own sign-in, so no key goes into the agent's config.
- `nxis status` reports where you are, so an agent knows which steps to skip.

## Install and run

Two ways, both the same CLI. The installer needs nothing else on the machine: it installs nxis
with its own Node.js, which never touches yours.

**The installer**, on macOS and Linux (and Windows, inside WSL):

```bash
curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh
nxis signup
```

It puts nxis in `~/.nxis`, with an `nxis` command in `~/.local/bin`, and adds that folder to your
PATH. Before it installs anything, it checks that the release is signed by NxisAI's release key and
that the download matches the signed checksum. `NXIS_INSTALL_VERSION=0.2.0` installs a given
version, `NXIS_INSTALL_DIR` and `NXIS_BIN_DIR` change the folders, and `NXIS_NO_MODIFY_PATH=1`
leaves your shell's startup file alone.

**npm**, anywhere with Node.js 20 or later, including Windows itself and Alpine:

```bash
npx -y @nxisai/cli signup          # without installing
npm install -g @nxisai/cli         # or install the `nxis` command
```

The installer has builds for macOS and Linux on arm64 and x64 (glibc). On Alpine or
another musl-based Linux, the installer says so and points to npm.

### Windows

Install nxis inside WSL, where it runs as on Linux and opens links in your Windows browser:

1. In PowerShell, run `wsl --install`, restart if asked, and open Ubuntu from the Start menu.
2. In the Ubuntu terminal, run the installer command above.
3. Install your coding agent inside WSL too, so it can start `nxis mcp serve`.

The installer stops with these steps if you run it in Git Bash, MSYS2 or Cygwin.
[docs/wsl.md](docs/wsl.md) has more, including how to check each part works.

### Updating

`nxis update` updates an install from the installer in place: it downloads the new version,
checks its signature and checksum, and switches to it, keeping the version it replaced
(`nxis update --to <version>` goes back). `nxis update --check` only says whether a newer version
is out. For npm it prints the command instead: `npm install -g @nxisai/cli@<version>`.

### Checking a download yourself

Each release on [GitHub](https://github.com/nxisai/cli/releases) has, for each platform,
`nxis-<version>-<platform>.tar.gz` and its `.sha256`, plus `manifest.json` (every file's sha256)
and `manifest.json.sig` (an Ed25519 signature over the manifest). The installer and `nxis update`
check both for you. To check by hand, with the public key from
[src/release-keys.ts](src/release-keys.ts) of that release:

```bash
v=0.2.0; p=darwin-arm64            # the version, and your platform
gh release download "v$v" -R nxisai/cli -p manifest.json -p manifest.json.sig -p "nxis-$v-$p.tar.gz"
node -e '
  const c = require("crypto"), f = require("fs");
  const key = c.createPublicKey({ key: Buffer.from(process.argv[1], "base64"), format: "der", type: "spki" });
  const ok = c.verify(null, f.readFileSync("manifest.json"), key, Buffer.from(f.readFileSync("manifest.json.sig", "utf8"), "base64"));
  console.log(ok ? "signature: good" : "signature: BAD");
' '<the public key>'
grep -A1 "\"nxis-$v-$p.tar.gz\"" manifest.json     # the sha256 the signature covers
shasum -a 256 "nxis-$v-$p.tar.gz"                     # has to match it
```

### Uninstalling

`nxis logout` first, to remove the stored sign-in from the OS keychain. Then:

- Installer: `rm -rf ~/.nxis ~/.local/bin/nxis`, and the `# nxis` PATH line from your shell's
  startup file.
- npm: `npm uninstall -g @nxisai/cli`.

Settings stay in `~/.config/nxis` (or `$XDG_CONFIG_HOME/nxis`); delete it too to forget them.

## Seeing what it does

The source being readable is only half an answer. To watch a single command instead of reading
the repository:

```bash
nxis orgs list --verbose
```

```
→ GET https://accounts.nxis.ai/v1alpha/accounts/65d.../organizations
    authorization: bearer <redacted>
← 200 https://accounts.nxis.ai/v1alpha/accounts/65d.../organizations
```

Every request is printed before it is sent, with credentials removed — a bearer token, an API
key, a refresh token and a PKCE verifier are never printed whatever flags you pass. The trace
goes to stderr, so `--json` on stdout stays machine-readable alongside it.

To see a change without making it:

```bash
nxis orgs create --name "Acme" --dry-run
```

A dry run still reads, so the command gets far enough to show you the write it would make, then
stops before sending it. It exits `0` — it did what you asked — and under `--json` returns the
method, URL and body it would have sent.

Sign-in is the exception: `--dry-run` does not block the token request, because without a token
every later command would report being signed out and tell you nothing about itself.

## Source availability and contributions

This repository is public so you can read the CLI, audit what it does with your credentials, and
build it yourself. It is licensed under [Apache-2.0](LICENSE).

**We are not accepting pull requests yet.** The API this CLI talks to is still moving — in a
single week the token audience changed, the environment variables were renamed, and the `--json`
reason codes changed with them. A patch written against one week can be invalidated by the next,
and asking for code against that would waste your time.

**Issues are open and genuinely useful.** Bugs, unclear error messages, and platform-specific
breakage all help. If a fix is right we will implement it and credit you by name.

See [CONTRIBUTING.md](CONTRIBUTING.md) for what we can accept today and what has to be true
before that changes, and [SECURITY.md](SECURITY.md) for reporting a vulnerability privately.

## Telemetry

**This version sends none.** There is no analytics or usage-reporting call of any kind, and
nothing leaves your machine except the NxisAI API calls needed to run the command you typed. The
only runtime dependencies are the MCP SDK and `zod`, which make no calls of their own.

We do expect to add usage events later — they are genuinely useful for finding which commands
fail and where people get stuck. When that happens:

- This section will say exactly what is collected, before the release that first sends anything.
- There will be a documented way to turn it off, and `DO_NOT_TRACK=1` will be honored.
- Credentials, API keys, organization names, and the contents of your files are not the sort of
  thing we would collect, and we will not start.

If the version you have installed still shows this section saying none, that is still true of
it — check the copy that shipped with your version rather than this page.

## Commands

```
nxis signup                      Sign in, create an organization, list plans
nxis login [--web]               Sign in (device code by default; --web uses a browser redirect)
nxis status                      Where you are in setup; safe to run any time
nxis plans                       Plans available to buy
nxis subscribe [<tier>]          Activate a free plan, or pay for a paid one; with no tier, a
                                 terminal offers the plans to choose from
nxis credits                     Credit balance
nxis credits packs               Credit packs available to buy
nxis credits buy <sku>           Buy a top-up (needs an active plan)
nxis crawl submit [<sitemap-url>] [--wait]
                                 Check the sitemap names the site's host, then crawl it
nxis crawl status [<sitemap-url>] [--wait]
nxis autofill plan [--existing import_and_complete|import|generate]
                   [--media-type HTML|IMAGE|VIDEO|AUDIO] [--pattern <path>]
                                 Count what structured data would cover; changes nothing
nxis autofill submit [same options] [--yes] [--wait]
                                 Generate it: spends credits, asks first, submits once
nxis autofill status [--batch <id>] [--wait] [--recent]
                                 Follow a batch; --recent lists the site's latest batches
nxis publish [--dry-run] [--type <schema-type>] [--yes]
                                 Make generated data live: asks first (--dry-run counts it)
nxis orgs create --name <name> [--website <url>]
nxis orgs list
nxis orgs use <org-id>
nxis orgs update [--name <name>] [--website <url>] [--industry <text>]
nxis mcp install [--print]       Wire the onboarding tools into your agent as a local server (no key)
nxis mcp install --remote        Instead, create an MCP key and wire in the remote endpoint
nxis mcp serve [--read-only] [--allow-unconfirmed]
                                 Run the onboarding tools as a local MCP server on stdio
nxis mcp public on|off           Make the site's MCP server public, or not
nxis mcp settings [--set key=value …]
nxis actions bind <action|booking|default> --connection <name|id> | --webhook <url> | --gateway | --self-page
                 [--supports-check[=false]] [--availability-url <url>]
nxis actions on|off              Turn the site's action tools on or off, keeping every route
nxis connections list            The site's connections: name, address, secret preview, who uses each
nxis connections create --name <name> --url <url> [--default] [--write-env <file> [--env-name <var>]]
                                 A named address agents and actions send to; its secret is shown once,
                                 or written into an ignored env file with --write-env
nxis connections rotate <name|id> [--yes] [--write-env <file> [--env-name <var>]]
nxis connections delete <name|id> [--yes]
nxis connections test <name|id> [--action <type>] [--turn-on-checks]
                                 Send one signed check call to its address, report the verdict and
                                 whether it answers checks; --turn-on-checks turns check support on
nxis discovery files [--write] [--out <dir>]
nxis keys create --scope content_gaps:report
                                 A key for the current site that can only report its content gaps
nxis keys list [--all]           The current site's keys you created
nxis keys revoke <key-id>        Revoke a key
nxis agents status               The site's hosted agents: on or off, kill switch, policy version, notices
nxis agents catalog [--job <job>]... [--industry <name>]... [--readiness <r>]... [--added|--not-added] [--query <words>] [--by-fit]
                                 The agents NxisAI offers, how well each fits the site, and what each still needs
nxis agents catalog <id>         One agent: its settings as flags, with their limits, what it needs, and its enable line
nxis agents enable <id> [--<setting> <value>]... [--connection <name|id>]
nxis agents configure <id> [--<setting> <value>]... [--clear <setting>]...
nxis agents disable <id>
nxis agents pause [<id>] [--tools] [--reason <text>]
nxis agents resume [<id>]
nxis agents brand [--name <text>] [--logo <https url>] [--accent <#rrggbb>] [--privacy-url <https url>] [--clear name|logo|accent|privacy-url]...
nxis agents policy set <file.json | ->
nxis agents policy show [--instructions]
nxis agents transcripts list [--limit <n>] [--page-token <t>]
nxis agents transcripts show <id>
nxis agents transcripts export [--out <file>] [--format json|csv] [--force]
nxis agents transcripts delete <id> | --all [--yes]
nxis agents transcripts settings [--retention-days <n>] [--dont-store | --store]
nxis agents transcripts webhook set <url> [--keep-secret] | remove | status
nxis agents dpa                  The data processing agreement: current version, link, who accepted it
nxis agents dpa accept [--yes]   Accept the current version for your organization, after showing it and its link
nxis types                       Types the site's MCP server serves, with counts
nxis query <type> [--text <q>] [--filter path=op:value …] [--limit n] [--exact] [--page-token <t>]
nxis whoami                      Who is signed in
nxis logout                      Forget stored credentials
nxis update [--check] [--to <version>] [--from <dir>]
                                 Update nxis (in place for the installer's copy), or say how
```

Options:

A flag the command doesn't take is refused before anything is read, saved or sent: exit `1` with
`unknown_flag`, naming the flag and the flags the command does take, closest match first
(`--json` gives them as `flag`, `command` and `known_flags`). The flags below without a command
named are taken by every command. `agents enable` and `agents configure` take the agent's own
settings as flags, checked against its setup the same way.

| Option | Effect |
|--------|--------|
| `--json` | Machine-readable output: one object on stdout |
| `--verbose` | Print every request before it is sent, credentials removed |
| `--dry-run` | Show what would be sent without changing anything; implies `--verbose` |
| `--api <url>` | Point every service at another NxisAI environment |
| `--org <id>` | Act on this organization instead of the saved one |
| `--profile <name>` | A name for the environment `--api` points at, shown by `nxis status` |
| `--site <id\|domain>` | Act on this site instead of the saved one |
| `--no-open` | Print payment links instead of opening a browser |
| `--timeout <minutes>` | How long to wait for a payment (default 15), a crawl (30) or an autofill batch (60) |
| `--yes` | Skip the confirmation for `autofill submit`, `publish`, `agents transcripts delete`, `connections rotate` or `connections delete`, once the user has seen the plan, the count or what would change |
| `--agent <name>` | `mcp install`: the agent to configure: `claude-code` (local scope, never committed), `cursor`, or `mcp-json` (`./.mcp.json`, added to `.gitignore`: it is never committed) |
| `--stdio` / `--remote` | `mcp install`: the local server (the default), or the remote endpoint with a key |
| `--force` | `mcp install`: replace an existing MCP server entry |
| `--print` | `mcp install`: print the MCP config instead of installing it |
| `--set key=value` | `mcp settings`: change a setting; repeatable |
| `--write`, `--out <dir>` | `discovery files`: merge the documents into the site's public root |
| `--filter path=op:value` | `query`: a field filter; repeatable |
| `--scope <scope>` | `keys create`: what the key may do; `content_gaps:report` is the only scope so far |
| `--all` | `keys list`: include revoked keys |
| `--<setting> <value>` | `agents enable` and `agents configure`: one of the agent's settings, by the flag `agents catalog <id>` lists (`--label`, `--description`, `--example <q>`, `--model <id>`, `--slot-minutes <n>` …); a list setting repeats (`--example a --example b`) and replaces the list |
| `--connection <name\|id>` | `agents enable`: route the agent's requests through this connection, for an agent that sends requests to the site (Quote, Booking) |
| `--clear <setting>` | `agents configure`: return a setting to its default (repeats) |
| `--job`, `--industry`, `--readiness`, `--added`, `--not-added`, `--query`, `--by-fit` | `agents catalog`: filter by job, industry or readiness (`available`, `early_access`, `coming_soon`; each repeats), by whether the site has added the agent, by words, and order by fit |
| `--name <text>`, `--logo <url>`, `--accent <#rrggbb>`, `--privacy-url <url>`, `--clear <part>` | `agents brand`: the chat's name, logo, accent color and privacy page; `--clear name\|logo\|accent\|privacy-url` resets one (repeats) |
| `--tools`, `--reason <text>` | `agents pause`: pause actions only (tools that change something; answers and read-only lookups go on); what visitors are told |
| `--limit <n>`, `--page-token <t>` | `agents transcripts list`: page size (1 to 100, default 25) and the page to read |
| `--out <file>`, `--format json\|csv`, `--force` | `agents transcripts export`: where to write it (stdout without it), JSON or CSV, and replace an existing file |
| `--all` | `agents transcripts delete`: every conversation of the site |
| `--retention-days <n>`, `--dont-store`, `--store` | `agents transcripts settings`: days kept (1 to 3650), or store none, or store again |
| `--keep-secret` | `agents transcripts webhook set`: change the URL only, keeping the signing secret |
| `--connection <name\|id>` | `actions bind`: send the route through this connection |
| `--supports-check[=false]` | `actions bind`, any route: the receiver answers availability checks, so agents check first (Booking's open times and holds, Quote's service area); left out, it stays as it is |
| `--availability-url <url>` | `actions bind`, Booking only (`booking`, `schedule`, `reserve`): where free times are read; left out, it stays as it is, and an empty URL clears it |
| `--name <name>`, `--url <url>`, `--default` | `connections create`: the connection's name (1 to 60 characters, unique on the site), its https address, and make it the site's default |
| `--write-env <file>`, `--env-name <var>` | `connections create`, `connections rotate`: write the signing secret into that env file as `NXIS_ACTION_SECRET` (or `<var>`) instead of showing it; git must ignore the file, or it must be outside a repository |
| `--action <type>` | `connections test`: the action the example arguments are for: `quote`, `booking`, `schedule`, `reserve`, `ask`, …, `default`, or an action type such as `QuoteAction`; left out, the connection's own route |
| `--turn-on-checks` | `connections test`: when the receiver answers availability checks, turn check support on for every route on the connection that has it off |

## Sites

The site steps of onboarding, one command each. They follow the Site Onboarding skill
(`agentic-site-onboarding`), so an agent or a script can run the same steps and branch on the exit
code. Each acts on the current site: `--site <id|domain>`, else the one `sites create` or
`sites use` saved.

```
nxis sites create <url> [--name <name>]   Step 1: create the site and make it current
nxis sites list                           The organization's sites; * marks the current one
nxis sites use <id|domain>                Pick the site the other commands act on
nxis sites verify --token                 Step 2: the META tag to add and deploy to production
nxis sites verify --check                 Step 3: check the tag is live
nxis sites name <name>                    Step 9: the name the NxisAI app lists it under
nxis sites list-in-app [--preview|--off]  Step 9: list it in the NxisAI app, or unlist it
nxis sites tag [status|issue]             After onboarding: the site tag, for a verified site
                [--domain <host>]... [--webmcp-mode browser|ssr|none]
```

A scripted run, from nothing to listed:

```bash
nxis sites create https://example.com --json          # saves the new site as current
nxis sites verify --token --json | jq -r .content     # write it into <meta name="nxisai-verification">
# … deploy to production …
nxis sites verify --check --json                      # exit 2 until the tag is live: wait, run it again
nxis sites list-in-app --preview --json               # how the app would list it; changes nothing
nxis sites name "Example Outfitters"
nxis sites list-in-app
```

**The host is fixed at creation.** `www.example.com` and `example.com` are different sites, and a
site created on the wrong one has to be deleted, not edited. Create it on the host production
serves.

**A deploy preview never verifies.** `verify --check` fetches the site's own URL, so a tag on a
preview or branch deploy's generated host is never seen. Until the tag is live in production,
`--check` exits `2` (`site_not_verified`) with the verifier's reason in `verifier_reason`: wait for
the deploy and check again, rather than treating it as an error. When the site cannot be fetched
at all (an unknown host, a refused connection, a TLS failure), it exits `2` with
`site_unreachable` instead: waiting will not help, so deploy the site at its address first.

**Finding a site by domain.** `sites use` and `--site` match a domain or URL against each site's
host exactly. Only when no site has that exact host is a leading `www.` ignored, and `sites use`
then says so (`"match": "www"`). When more than one site matches, nothing is chosen
(`site_ambiguous`, exit 2) and the candidates are listed; pass the id instead.

`--dry-run` still runs the reads (`verify --token`, `tag`, `list-in-app --preview`, `list`, and the
lookup of a domain) and withholds the writes: `create`, `name`, `verify --check`, `tag issue` and a
listing change. `create --name` under `--dry-run` reports both calls it would make.

| Command | `--json` on success | Exit when not done |
|---------|--------------------|--------------------|
| `create` | the site (`site`, `domain`, `is_verified`, …), `org_id`, `display_name`, `current`, `warning` | `site_name_failed`, with the naming call's exit code, if the site was created but not named (it is still saved as current) |
| `list` | `organization`, `count`, `truncated`, `current`, `sites[]` each with `current` | |
| `use` | `site`, `org_id`, `domain`, `display_name`, `is_verified`, `match` (`id`, `host` or `www`) | 2 `site_not_found`, `site_ambiguous` |
| `verify --token` | `site`, `tag`, `name`, `content`, `next` | |
| `verify --check` | `site`, `verified: true`, `url` | 2 `site_not_verified` or `site_unreachable`, with `verifier_reason` |
| `name` | `site`, `display_name` | |
| `list-in-app` | `site`, `preview`, `listed_in_app`, `as_listed`, `next` | |
| `tag` | `site`, `mode`, `exists`, `script_tag`, `token`, `claims`, `next` | 2 `site_not_verified` for `issue` |

Every site-scoped command exits `2` with `no_active_site` when no site is selected.

## Site keys

A site key is bound to one site of your organization and limited to one scope. It's for software
that runs on the site's own server and needs exactly one narrow write, so you don't have to put
your organization's key on a public-facing host. Every other NxisAI surface refuses it.

| Scope | The key can |
|-------|-------------|
| `content_gaps:report` | Report the site's content gaps (questions its help content couldn't answer) and helpful counts. It can't read them, create or change sites, publish, or spend credits |

```
nxis keys create --scope content_gaps:report [--site <id|domain>]
nxis keys list [--site <id|domain>] [--all]
nxis keys revoke <key-id>
```

**The key is shown once.** `keys create` prints it, labelled, and includes it in `--json` as
`api_key`, because you asked for it. It isn't shown again, the CLI doesn't keep it, and the
`--verbose` trace never contains it. Store it in the server's secrets. If it leaks, revoke it and
create another: a revoked key stops working on its next use.

**The site must be one of your organization's.** `--site` takes an id or a domain, as elsewhere,
and is checked against `nxis sites list` before anything is minted (`site_not_found`, exit 2).

**A service without site keys gets no key.** If the authorization service hands back a key that
isn't bound to the site and scope you asked for, the CLI revokes it straight away, shows nothing,
and exits `1` with `site_keys_unsupported`.

**`keys list`** lists the site keys you created, never their secrets. Keys created by other
members of the organization aren't listed. **`keys revoke`** takes a key id from the list. A key
that is unknown, already revoked, or belongs to another organization is reported as
`already_gone`, and nothing changes.

`--dry-run` runs the site lookup and `keys list`, and withholds `create` and `revoke`.

| Command | `--json` on success | Fails with |
|---------|--------------------|------------|
| `create` | `api_key`, `key_id`, `preview`, `scopes`, `site`, `domain`, `org_id`, `env` | 1 `missing_scope`, `unknown_scope`, `site_keys_unsupported` (with `key_id`, `revoked`); 2 `no_active_site`, `site_not_found`, `site_ambiguous` |
| `list` | `site`, `org_id`, `count`, `keys[]` each with `key_id`, `preview`, `scopes`, `site`, `env`, `kind`, `created_at`, `last_used_at`, `revoked_at`, `revoked` | 2 `no_active_site`, `site_not_found` |
| `revoke` | `key_id`, `org_id`, `revoked`, `outcome` (`revoked` or `already_gone`) | 1 `missing_key_id` |

Times are epoch seconds. Outside production, site keys are development keys (`nxis_dev_mcp_…`), like
MCP keys.

## Hosted agents

A site can run the hosted agents NxisAI offers: the on-page assistant (the chat on your pages),
the Support Agent, which answers from the site's MCP server, Quote and Booking, which send
requests to the site's own servers through a connection, and any agent NxisAI adds later. Each has
an id in the agent catalog (`page`, `support`, `quote`, `booking` …). `nxis agents` turns them on
and off, configures and pauses them, brands the chat, sets their guardrails policy, and accepts the
data processing agreement that going live needs. The NxisAI API serves every one of these commands,
and changes reach the site within seconds.

```
nxis agents status                       What runs on the current site
nxis agents catalog [--by-fit]           The agents NxisAI offers, and how well each fits the site
nxis agents catalog quote                Quote's settings as flags, with their limits, what it needs, and its enable line
nxis agents enable page [--model <id>]
nxis agents enable support --label "Help" [--description <text>] [--example "Do you ship to Canada?"]... [--model <id>]
nxis agents enable quote --label "Get a quote" --connection Website
nxis agents enable booking --label "Book a visit" --slot-minutes 60 --connection Website
nxis agents configure booking --lead-minutes 240 --clear description
nxis agents disable <id>                 Turn one off; its settings are kept
nxis agents pause [<id>] [--tools] [--reason <text>]
nxis agents resume [<id>]
nxis agents brand --name "Wrenfield" --logo https://example.com/logo-mark.svg --accent "#C73A17" --privacy-url https://example.com/privacy/
nxis agents brand --clear logo        Back to the default mark
nxis agents policy set policy.json       Or `-` to read it from stdin
nxis agents policy show [--instructions] The policy, and the version of NxisAI's instructions
nxis agents dpa                          The data processing agreement, and whether it is accepted
nxis agents dpa accept [--entity <name>] [--yes]  Accept its current version
```

**Each agent's settings come from the catalog.** `nxis agents catalog <id>` lists them as flags,
with their type, limits and whether they are required, and prints the shortest `enable` line that
works. The CLI reads them from the service each time, so an agent NxisAI starts hosting works
without updating the CLI. The flags are checked before anything is sent, as the service checks
them, with lengths counted in UTF-16 code units as the service counts them. In a reason, a
flag's `-` is written `_`:

| Reason | Exit | When |
|---|---|---|
| `missing_<flag>` | 1 | A required setting would be empty (`missing_label`) |
| `<flag>_too_long` | 1 | Longer than its limit (`label_too_long`, `description_too_long`, `example_too_long`), with `limit` and `length` |
| `too_many_<setting>` | 1 | A list with too many items (`too_many_examples`), with `limit` and `count` |
| `invalid_<flag>` | 1 | Out of range, not one of its values, not an https URL, not a color, an empty or repeated item (`invalid_slot_minutes`), with `rule` and `min`/`max` or `allowed` |
| `unknown_flag` | 1 | A flag that isn't one of the agent's settings, with `allowed` |
| `model_retired` | 1 | A model no longer offered, with `allowed` |
| `unknown_agent`, `agent_not_hosted` | 1 | No agent has that id, or NxisAI doesn't host it yet |
| `connection_required` | 2 | The agent needs a connection and has none: `connections` lists the site's by name; run it again with `--connection <name>` |
| `connection_not_found`, `connection_unusable` | 2 | `--connection` names none of the site's connections, or its route can't be sent through |
| `records_missing` | 2 | The site's records lack what the agent needs (Quote: prices; Booking: services), with `types` |
| `actions_off` | 2 | The site's actions are turned off (`nxis actions on`) |
| `opening_hours_required` | 2 | Booking from opening hours, and the site has none set |
| `version_conflict` | 1 | Someone else changed the settings, after one automatic retry |
| `hosted_agents_unavailable` | 1 | This NxisAI environment can't turn that agent on from the CLI yet |

A refused `enable --connection` may already have pointed the agent's route at the connection,
which stays. The settings given with it are then saved too, with the agent left off, and the
failure says so in `kept` (`["route", "settings"]`); when they couldn't be saved, `kept` is
`["route"]` and `settings_error` names why. Run `enable` again once the cause is fixed.

`enable` and `configure` print `agent: {id, enabled, state, state_reason, settings, kill_switch,
effective_kill_switch, prerequisites}` and `changed`; for `page` and `support` they also print
every key they always did. `state` is `off`, `needs_setup`, `preview`, `paused` or `live`. An
agent that is on but doesn't answer visitors yet (the Support Agent without an MCP server, say)
still exits 0, with `state: "needs_setup"`, the reason in `state_reason`, and a `next` line.
`configure` changes settings without turning the agent on or off; `--clear <setting>` returns one
to its default; it takes the flag (`example`) or the setting's name (`examples`). `status --json` adds `agents`, one entry per hosted agent.

**The Support Agent needs a label**, the name a visitor reads: `--label`, or the one already set
(`missing_label` otherwise). `--example` repeats and replaces the example questions: up to 10, of
at most 200 characters each. A pause reason is at most 200 characters.

**`pause` is the kill switch.** It refuses every turn, or with `--tools` only the turns that would
use tools; `--reason` is what visitors are told. `pause <id>` (`pause support`, `pause quote`) pauses that agent
only; with no agent named, it pauses every hosted agent on the site. An agent is held to the
stricter of its own pause and the site's. `resume` turns off the one it names, or the site-wide
switch with none named; each is separate, so `status` shows any agent still paused by name.

**`brand` sets how the chat looks on the site**: the name visitors see on the chat button and in the
chat, the logo (a square mark works best), the accent color, and the privacy page the chat's notice
links to. Without it the chat shows the default look. Only the parts given change; `--clear <part>`
resets one to the default (`--clear privacy-url` removes the link), and repeats. The values are
checked before anything is sent, as the service checks them: a name of 1 to 60 characters
(`invalid_name`, `name_too_long`); the logo and privacy page as full `https://` URLs with a host,
of at most 2,048 characters, never markup or a bare path such as `/logo.svg` (`invalid_url`); and the
accent as `#rgb` or `#rrggbb` (`invalid_accent`). Quote the accent in a shell, where `#` can start a
comment.

**`policy set`** takes a JSON object (`invalid_policy` otherwise) and replaces the policy document.
The service gives each new policy a version, `v<n>`, which `status` and `policy show` print.

**The hosted agents follow NxisAI's instructions.** NxisAI sets them, fills them in with your
site's name and the assistant's label, and improves them for every site at once. You shape what
the agents say with the settings you already control: the label, the Support Agent's replies and
the guardrails policy. A policy can't set `systemPrompt`: `policy set` refuses one before sending
anything (exit 2, `system_prompt_not_settable`), so remove the key to save the rest.
`policy show` prints the version the on-page assistant follows
(`Instructions: NxisAI, version 3, published 2026-11-14`), and `--instructions` prints them in
full, as the assistant uses them. `--json` has `instructions: {type, version, publish_time}`, plus
`text` with `--instructions`. An agent you deploy yourself is unchanged: its own code sets its
prompt.

`status` lists any notices about your hosted agents that you haven't dismissed in the dashboard,
such as instructions that were replaced with NxisAI's.

Every change reads the settings, changes one thing and writes them back whole, so nothing else
moves. If the settings already say what you asked, nothing is sent (`"changed": false`). If someone
else changes them at the same moment, the CLI retries once, then stops with `version_conflict`:
run the command again. `--dry-run` shows the write without sending it.

With `--json`, `status` and every change print one object:

```json
{
  "ok": true, "org": "…", "site": "…", "version": 12,
  "page": {
    "enabled": true, "model": null, "kill_switch": null,
    "branding": { "name": "Wrenfield", "logo_url": "https://example.com/logo-mark.svg", "accent_color": "#C73A17" },
    "privacy_url": "https://example.com/privacy/"
  },
  "support": { "enabled": true, "label": "Help", "description": "", "examples": [], "model": null, "kill_switch": null },
  "kill_switch": null,
  "policy_version": "v12",
  "mcp_server": { "url": "https://example.com/mcp", "public": true, "api_key_id": null },
  "verified_hosts": ["https://example.com"],
  "changed": true
}
```

`kill_switch` is `{ "scope": "agent" | "tools", "reason": "…" }` while it is on: at the top level for
the whole site, and in `page` and `support` for that agent's own pause. `changed` is only in the
result of a change. Each part of `page.branding`, and `page.privacy_url`, is null while it is the
default. `transcripts` is `{ "store": true, "retention_days": 30, "webhook_url": null,
"webhook_secret_id": null }`: the secret's id is a reference, never the secret.

### The data processing agreement

Your agents process what visitors type, so before they answer visitors, someone in your organization
accepts NxisAI's data processing agreement for hosted agents. Each version is published at
`https://nxis.ai/dpa/<version>`. Your organization accepts once, and the acceptance covers all of its
sites. A site that belongs to a different legal entity than your organization is accepted by that
entity, for that site only: pass `--entity` with the entity's name.

Until the current version is accepted, a site's agents don't answer visitors: a site in preview
can't go live, and a site set up before preview existed waits on the agreement. `nxis agents status`
says that the agreement is what holds it back.

On a terminal, `nxis agents enable <id>` offers it first when the site's agents wait on it: the
version and its link, then a choice of accepting for the organization, accepting for the legal
entity the site belongs to (you type its name), or cancelling, which changes nothing. Nothing is
preselected. `--yes`, `--json` and a run without a terminal skip the question and enable as before.
Through `nxis mcp serve`, `nxis_accept_dpa` puts the same choice to you in your agent.

```
nxis agents dpa                               The current version, its link, and who accepted it and when
nxis agents dpa accept                        Show the version and its link, ask, then accept that version
                                              for your organization
nxis agents dpa accept --yes                  The same without the question, once the user has read it and agreed
nxis agents dpa accept --site <id> --entity "<name>"
                                              Accept it for a site of a different legal entity, for that site only
```

**`dpa accept` never accepts on its own.** It prints the version and the link, then asks on a
terminal. With no terminal (an agent, a pipe, CI) and no `--yes`, it stops with exit 2,
`confirmation_required`, the `version` and the `url`: show them to the user, and run it again with
`--yes` once they agree. Pass `--yes` only on the user's word. It sends exactly the version it
showed: if a newer one is published in between, it is refused (`dpa_version_changed`, exit 2, with
the new `version` and `url`) rather than accepted unread. With no version published, there is
nothing to accept (`dpa_not_published`, exit 1). When the current version is already accepted,
nothing is sent (`"changed": false`). `--dry-run` shows the request without sending it.

Accepting needs a person signed in: the acceptance records who accepted it, and they confirm they're
authorized to bind the organization, or the entity. Once a site belongs to another legal entity,
only that entity's acceptance counts for it, and accepting without `--entity` stops with
`dpa_entity_required` (exit 2). An `--entity` that's empty, longer than 200 characters or holds
control characters is `invalid_entity` (exit 1).

When NxisAI publishes a newer version, the earlier acceptance is kept, and `nxis agents dpa` shows
`newer_version`. The earlier version keeps applying for 30 days (`grace_end`); after that the
site's agents return to preview until the new one is accepted. Going live from preview needs the new
one.

With `--json`, `dpa` and `dpa accept` print one object:

```json
{
  "ok": true, "org": "…", "site": "…",
  "state": "accepted",
  "version": "2026-11-16", "url": "https://nxis.ai/dpa/2026-11-16",
  "accepted": true,
  "accepted_for": "organization", "legal_entity": null, "grace_end": null,
  "acceptance": { "version": "2026-11-16", "accepted_by": "…", "accept_time": "2026-11-16T14:05:00Z", "legal_entity": null, "url": "https://nxis.ai/dpa/2026-11-16" },
  "acceptances": [ … ],
  "organization_acceptances": [ … ]
}
```

`state` is `accepted`, `not_accepted`, `newer_version` (an earlier version was accepted, the current
one isn't yet) or `not_published` (`version` and `url` are then null). `accepted_for` is
`organization`, or `legal_entity` with its name in `legal_entity`. `acceptance` is the latest
acceptance that counts for the site, of any version; `acceptances` are the site's own (an entity's,
or from before the organization accepted), and `organization_acceptances` the organization's.
`grace_end` is when an earlier version stops applying, while it still does. `NXIS_DPA_URL` points
the links at another copy of the agreement, such as a staging site. `status --json` carries `live`
(whether visitors reach the agents), `waiting_on_dpa`, `dpa` (`state`, `version`, `url`,
`accepted`, `accepted_for`, `legal_entity`, `grace_end`) and `go_live_blocked_by`:
`dpa_not_accepted`, `dpa_not_published`, or null.

### Transcripts

What the hosted agents' visitors said and what the agents answered, redacted before it is stored
and kept for the site's retention period (30 days unless set).

```
nxis agents transcripts list [--limit <n>] [--page-token <t>]   Newest first, without the messages
nxis agents transcripts show <id>                               One conversation, every message
nxis agents transcripts export --out transcripts.json           Every conversation, every page
nxis agents transcripts export --out transcripts.csv --format csv
nxis agents transcripts delete <id>                             Asks first; --yes skips the question
nxis agents transcripts delete --all
nxis agents transcripts settings --retention-days 90
nxis agents transcripts settings --dont-store                   Store none; a webhook is then the only copy
nxis agents transcripts webhook set https://example.com/hooks/nxis
nxis agents transcripts webhook set https://example.com/hooks/v2 --keep-secret
nxis agents transcripts webhook remove
nxis agents transcripts webhook status                          Deliveries, and the ones that gave up
```

**`export`** reads every page into one JSON document, `{ "site", "exported_at", "transcripts" }`,
or with `--format csv` one row per message, with the dashboard's columns. A CSV field that starts
with `=`, `+`, `-`, `@`, a tab or a carriage return gets a `'` in front, so a spreadsheet shows it as
text instead of running it. The file is created readable by you only, and an existing file is
kept unless you pass `--force`. Without `--out` the export goes to stdout; with `--json` that is the
JSON document with `"ok": true`, and a CSV needs `--out`.

**Deletes cannot be undone.** On a terminal, `delete` shows which conversation (or that it is all
of them) and asks. Anywhere else it stops with `confirmation_required` (exit 2) until `--yes` says
the user was asked. `--dry-run` shows the delete without sending it.

**`settings`** with no option shows the settings; `--retention-days` and `--dont-store` / `--store`
change them the way every `nxis agents` change does, keeping every other setting.

**`webhook set <url>`** makes a signing secret on your machine (`whsk_` and 32 random bytes,
base64url), sends it once, and prints it once: store it with the receiver now, since it cannot be
read back. The CLI never writes it to its settings, and `--verbose` and `--dry-run` show it as
`<redacted>`. Setting a webhook that already has a secret replaces the secret (`"rotated": true`);
`--keep-secret` changes the URL only. With `--json`, the result carries the new secret as
`secret`, once.

## The MCP server: local or remote

`nxis mcp install` registers the onboarding tools with your agent under the name
`nxis-onboarding`, in one of two ways.

**Local (the default, `--stdio`).** The agent's config gets a command and no key:

```json
{ "mcpServers": { "nxis-onboarding": { "command": "/usr/local/bin/nxis", "args": ["mcp", "serve"] } } }
```

The agent starts `nxis mcp serve`, which speaks MCP on stdin and stdout and runs each tool call
through the CLI: the provisioning tools on your organization's endpoint with the CLI's own
provisioning key from the keychain (minted on first use), and `nxis_list_types` and `nxis_query`
on the site's own public endpoint. It lists the same 16 tools under the same names as the remote
server, with the same schemas. Nothing is minted at install time, and nothing secret is written to
the agent's config.

- **The command** is the `nxis` you installed, by its absolute path, so the agent finds it whatever
  its `PATH`. When the CLI is running from `npx`'s cache (or another package runner's), which is
  pruned, the entry runs `npx -y @nxisai/cli@<version> mcp serve` instead, pinned to the version
  that ran the install, so the agent keeps running the CLI you set it up with. Run
  `mcp install --force` again after upgrading to move it on.
- **Organization and site** come from the CLI's saved state when the server runs, so
  `nxis orgs use` takes effect on the next tool call without reinstalling. `--org`, `--site`,
  `--api`, `--read-only` and `--allow-unconfirmed` given to `mcp install` are passed on to the
  server; nothing else is.
- **Scope before a submit.** An autofill `submit` that names no `pattern` or `media_type` first
  asks which pages it covers: all pages, or one of the site's path clusters (`/blog/*`,
  `/products/*`), each with its count (and an estimate for an import). The confirmation then names
  the narrowed plan's own count, and the batch runs with the cluster you chose.
- **The data processing agreement.** `nxis_accept_dpa` shows you the current version and its link
  and asks who accepts: the organization, or the legal entity the site belongs to (its name is a
  second question). The acceptance is recorded as yours, for that version. A client that can't ask
  gets `confirmation_unavailable` with `terminal_command: "nxis agents dpa accept"`.
- **Credits before a submit.** Before an autofill `submit` is put to you, the server reads the
  organization's real balance. Used up, or short of the plan's estimate, it offers the credit
  packs; a pack is a link to its payment page, and the call waits for the credits to land before
  asking about the submit. Under `--allow-unconfirmed`, a used-up balance is refused
  (`credits_exhausted`) rather than submitted.
- **Risky calls ask you first.** The calls that spend credits or change what the public sees
  are an autofill `submit`, a publish that isn't a dry run, turning the site's MCP server public,
  routing actions to a webhook, listing the site in the NxisAI app, creating, binding,
  rotating or deleting a connection, creating an organization, and turning a hosted agent on,
  changing one that is on, turning one off, resuming agents or changing the chat's branding.
  Turning public MCP off, removing the site from the app, changing an agent that is off and
  pausing agents don't ask, since they don't add to what visitors or the public meet. For
  these, the server asks you directly through your agent (MCP elicitation), before anything is
  sent. The question names what's at stake: the plan's count, credits and price, how many records
  would go live, the webhook's host, the site. Only an accept with the box ticked goes ahead. A
  decline or a dismissal returns `declined_by_user` or `cancelled_by_user`, and nothing is done.
  This holds even if something the agent read (a crawled page, a query result) talked it into
  the call.
- **When the agent can't ask.** Without elicitation support in the client, a risky call is refused
  with `confirmation_unavailable`. The refusal includes what the call would have done
  (`would_do`) and the terminal command that does the same (`terminal_command`, for example
  `nxis autofill submit`). Start the server with `--allow-unconfirmed` to let such calls run on the
  client's own per-call approval instead. A client that can ask is still asked.
- **`--read-only`** refuses every call that may change something (`read_only_server`). Reads,
  plans, statuses, previews and dry runs still work.
- **Annotations.** Every tool is listed with `readOnlyHint`, `destructiveHint`, `idempotentHint`
  and `openWorldHint`. A tool whose mode decides between reading and writing, such as
  `nxis_bulk_autofill`, is not marked read-only.
- **Webhooks and connections.** A result that binds a webhook or a connection states its host
  (`webhook_host`, and a line of text), so you can see in the transcript where submissions now go.
- **Connections.** Besides the remote endpoint's tools, the server has six of its own, which use the
  CLI's sign-in: `nxis_list_connections`, `nxis_create_connection`, `nxis_bind_connection`,
  `nxis_test_connection`, `nxis_rotate_connection_secret` and `nxis_delete_connection`. They do what
  `nxis connections` and
  `nxis actions bind --connection` do, and answer with the same JSON. A create or a rotation returns
  the new `signing_secret` once; no other result, and no log line, carries it. Given `write_env`
  (and optionally `env_name`), they write it into that env file instead, as `--write-env` does, and
  return only `written_to`, `env_name` and `secret_preview`: the secret never enters the
  conversation. A relative path is taken from the directory the server runs in.
- **Organizations.** `nxis_list_orgs` lists yours, with `current_org_id`; `nxis_use_org` (by id,
  or by exact name) makes one current without asking; `nxis_create_org` (`name`, and optionally
  `website` and `industry`) creates one after you confirm, or names the unnamed one a browser
  sign-up left, as `nxis orgs create` does. The choice is saved, and the server's next call acts on
  it, with no restart. A server started with `--org` keeps acting on that one: `nxis_use_org`
  refuses to switch it (`org_pinned`).
- **Hosted agents.** `nxis_agents_status` and `nxis_agents_catalog` read what `nxis agents status`
  and `nxis agents catalog [<id>]` print; one agent's entry adds `unmet` and `enable_with`, the
  arguments that turn it on. `nxis_enable_agent`, `nxis_configure_agent`, `nxis_disable_agent`,
  `nxis_pause_agents`, `nxis_resume_agents` and `nxis_agents_brand` do what their commands do,
  through the same code. Settings are an object keyed by setting name (`{"label": "Get a quote",
  "slot_minutes": 30}`), checked against the agent's own setup with the same limits and reasons as
  the flags, naming `settings.<name>`; `clear` takes setting names. Before an enable, the server
  asks which of the site's connections the agent sends through (when it needs one and none is
  given; "create a new one first" returns the step, and nothing is created for you), then offers
  the data processing agreement as `nxis agents enable` does on a terminal, then confirms. A
  refusal carries its `reason`, the unmet prerequisites, what was `kept`, and `next`: the tool call
  that meets it.
- **Signing in.** The server never prompts on the terminal. A call made while signed out, from a
  client that can ask, shows you the sign-in link and code through your agent (a link the client
  opens, where it supports URL elicitation), waits while you sign in on that page, and then runs
  the call once. Declining stops the wait (`declined_by_user`), and nothing is done. A client that
  can't ask gets `reason: "signed_out"` and a hint to run `nxis login`; after signing in, the next
  call works, with no restart. A revoked key is replaced automatically while the CLI is signed in.
- **Choosing a plan.** `nxis_choose_plan` puts the plans to you (price, interval and credit
  grant) and subscribes to the one you pick; a paid plan's payment page is a link, and the call
  waits for the payment to clear. An organization already on a plan is left as it is. A client
  that can't ask gets `confirmation_unavailable`, with the plans in `would_do` and
  `terminal_command: "nxis signup"`.
- **Failures** come back as tool results with `isError: true` and the same JSON object `--json`
  prints (`ok`, `reason`, `error`, and details). `--dry-run` withholds writes there too.
- stdout carries only MCP messages; logs, `--verbose` traces and notices go to stderr.

By hand, for Claude Code:

```bash
claude mcp add --scope local nxis-onboarding -- nxis mcp serve
# or, for an agent that should only read:
claude mcp add --scope local nxis-onboarding -- nxis mcp serve --read-only
```

**Remote (`--remote`).** As before the local server existed: a key is minted and written, with the
endpoint's URL, into the agent's config. Use it for an agent that cannot start a local process.

For Claude Code, `--remote` installs through `claude mcp add`, which takes a header only as a
command-line argument. So for the second or so that command runs, the key is in its arguments,
where another user on the same machine could read it (`ps`, `/proc/<pid>/cmdline`). On a shared
machine, use the local server, which has no key, or pass `--agent mcp-json` to write a gitignored
`.mcp.json` that only you can read, or `--print` to configure the agent by hand.

**`.mcp.json` is never committed.** It can hold credentials: with `--remote` the key is in its
headers, and other servers' entries may hold theirs. So whenever `mcp install` writes a project
`.mcp.json` (`--agent mcp-json`, or Claude Code when the `claude` command isn't available), it
keeps it out of git:

- If git already ignores it, nothing else changes.
- Otherwise it appends `.mcp.json`, with a comment, to the `.gitignore` next to it (creating that
  file), and says so (`"gitignored": "added"` in the JSON).
- If git already tracks it, ignoring it is too late. With `--remote`, it refuses to write a key
  into it (exit `2`, `mcp_json_tracked`) before minting one. Without a key, it writes the entry and
  warns. Either way: run `git rm --cached .mcp.json`, and rotate any key that was committed in it.
- Outside a git work tree, or without git, there is nothing to do.
- `--dry-run` writes neither file, and says what would happen to `.gitignore`
  (`"gitignored": "would_add"`).

Since the file stays on this machine, the installed `nxis`'s absolute path in it is fine.

The two share the server name, so `--force` replaces one with the other. The onboarding skill
calls the `nxis-onboarding` tools by name, so it works with either; with the local server, sign
in with the CLI first (`nxis login`, `nxis orgs use <id>`).

## Guided setup

Some setup steps are decisions only you can make. Rather than stopping with a reason you resolve
somewhere else, the CLI puts each one to you as a prompt: on a terminal, as a question; through
`nxis mcp serve`, over MCP elicitation, in your agent. Nothing is ever chosen for you, no answer is
preselected, and no prompt asks for or shows a password, card details or a secret. Sign-in and
payment stay on their own pages: the prompt takes you there and waits.

| Decision | On a terminal | Through `nxis mcp serve` | Without a prompt (`--json`, `--yes`, a pipe, a client that can't ask) |
|---|---|---|---|
| Sign in | A command that needs it offers the sign-in link and code, waits, and runs again once | Any call: the link and code, then the call runs once | Exit `3`, `signed_out` (a client that can't ask: `signed_out` and a hint) |
| Plan | `nxis signup`, and `nxis subscribe` with no tier, offer the plans | `nxis_choose_plan` | `choose_plan` or `missing_tier`; through an agent, `confirmation_unavailable` with `would_do` and `terminal_command` |
| Credits | `nxis autofill submit` with a used-up or short balance offers the packs, waits for the payment, then continues once | `nxis_bulk_autofill` `submit`: the packs, the payment page, then the usual confirmation | A used-up balance stops with `credits_exhausted`; a client that can't ask keeps `confirmation_unavailable` |
| Agreement | `nxis agents enable` offers the data processing agreement when the agents wait on it: the version and link, then accept for the organization, for the site's legal entity, or cancel | `nxis_accept_dpa`, and `nxis_enable_agent` before it turns the agent on | The enable runs as before and says the agreement holds the agent back; `nxis_accept_dpa` gives `confirmation_unavailable` |
| Organization | `nxis orgs create --name` reuses the unnamed organization a browser sign-up left | `nxis_list_orgs`, then `nxis_use_org` or `nxis_create_org` (confirmed); the next call acts on it | `no_active_org` |
| Connection | `nxis agents enable <id> --connection <name>` | `nxis_enable_agent` with no `connection`, for an agent that needs one: a choice of the site's connections, or "create a new one first", which returns the step | `connection_required`, with the site's connections and `next` |
| Turning an agent on | `nxis agents enable <id>` | `nxis_enable_agent`: the connection, the agreement, then the confirmation | `confirmation_unavailable`, with `would_do` and `terminal_command` |
| Autofill scope | `nxis autofill submit` with no `--pattern` or `--media-type` offers the site's path clusters, with counts, beside all pages | `nxis_bulk_autofill` `submit` with no `pattern` or `media_type`: the same choice, then the confirmation with the narrowed count | All pages, as before |

## Exit codes

The exit code tells an agent what to do next:

| Exit | Meaning | What an agent should do |
|------|---------|-------------------------|
| `0` | Done | Continue |
| `2` | Needs the user (sign-in, payment or a choice pending) | Relay the message; **do not retry** |
| `3` | Not authorized | Run `nxis login` |
| `1` | Failed | Report the error |

## JSON output

Every command accepts `--json` and then prints exactly one object on stdout. Failures include
`"ok": false` and a stable `reason` field to branch on, plus any details needed to continue (for
example `org_id` and `payment_url` when a payment is still pending). Progress messages go to
stderr, so `nxis plans --json | jq` works while a person still sees what is happening.

## Worth knowing

**A top-up needs a plan first.** Credits can only be added to an organization that has an active
plan, including the free one. `nxis credits buy` checks for one and refuses rather than opening a
payment page. Run `nxis subscribe free` first, then buy the pack.

**A payment timeout is not a failure.** The payment may still be processing. `subscribe` and
`credits buy` exit `2` with the payment URL and organization id in the JSON. The right next step
is `nxis status` (or `nxis credits`), never a second `subscribe`, which would open a second
checkout.

## Site data: crawl, autofill, publish

These take a verified site from its sitemap to structured data its MCP server serves. They act on
`--site` or the saved site.

```sh
nxis crawl submit --wait          # check the sitemap, crawl it, wait for COMPLETE
nxis autofill plan                # how many resources, and the credit balance
nxis autofill submit --wait       # spends credits: asks first, then submits once
nxis publish --dry-run            # how many records would go live
nxis publish                      # counts, asks, then makes them live
```

**The sitemap has to name the site's own host.** Before submitting, `crawl submit` fetches the
sitemap (`<site>/sitemap.xml` unless you pass a URL), follows a sitemap index into each sitemap,
and checks that every page's `<loc>` is on the site's host. Autofill bills for every page the
crawl finds and records its URL as a fact about the site, so a sitemap listing a deploy's
generated host (`*.netlify.app`, `*.vercel.app`, `*.pages.dev`) fails with an explanation (exit
`2`, `sitemap_off_host`). There is no flag to skip it: fix the origin in the project, deploy, and
crawl again.

**Wait for the crawl before planning.** The plan counts what the crawl found. `--wait` polls every
20 seconds until the crawl is `COMPLETE` (exit `0`) or `FAILED` (exit `1`, with the error), and
exits `2` (`crawl_running`) if `--timeout` runs out first; the crawl carries on.

**Autofill spends credits.** `autofill plan` changes nothing. It shows the number of resources,
the breakdown by media type and the organization's credit balance (`balance_milli`, as
`nxis credits` reads it; the plan's own `credits_remaining` when it can't be read). For `--existing import` it also shows the
fixed price per page. It never estimates a total for a generated mode, because the price per
generated page varies. `--existing` defaults to `import_and_complete`: each page's own JSON-LD is
imported, and only what it lacks is generated.

`autofill submit` plans again and asks before it submits, showing the count and the mode. With no
`--pattern` or `--media-type`, a terminal first offers the site's path clusters, each with its
count, beside all pages; the count it then asks about is the chosen cluster's. Without
a terminal, it exits `2` (`confirmation_required`) with the plan in the JSON. Show the plan to the
user, then run it again with `--yes`. It refuses up front when the plan counts nothing
(`nothing_planned`).

**Never into an empty balance.** Before it asks, `autofill submit` reads the organization's real
credit balance, the one `nxis credits` shows (allowance plus top-ups, less usage), rather than the
plan's own `credits_remaining`. When the balance is used up, or below the estimate (known for
`--existing import`, whose price per page is fixed), a terminal offers the credit packs to buy,
plus "submit anyway" when the balance isn't empty; a pack opens its payment page, and once the
credits land the submit carries on, once. With `--yes`, `--json` or no terminal, a used-up balance
exits `2` (`credits_exhausted`, with `remaining_milli` and the plan) and nothing is submitted; a
balance that is only short goes ahead, as before. When the balance can't be read (no sign-in beside
the provisioning key), the plan's `quota_exceeded` decides.

**Submit runs once.** If the submit does not answer (a timeout or a dropped connection), it may
still have started a batch. So the CLI never sends it again: it exits `2` (`submit_unconfirmed`)
and lists the site's latest batches, once. A batch that started after the submit was sent (give
or take a minute, for clock skew) is the one it started: its id is in `batch_id`, and it is saved
so `nxis autofill status --wait` follows it. When none has started yet, `recent_batches` shows what
is there, and `nxis autofill status --recent` looks again. `started: false` means a batch was
already running; nothing new started and nothing was charged.

**`PAUSED` means the credits ran out.** `autofill status` reads the batch's `status` and `terminal`
together. A paused batch will not advance on its own, and the CLI never resumes it: it exits `2`
(`autofill_paused`) and says how to buy credits (`nxis credits packs`). The pages already
generated are drafts, so publish them anyway. A `COMPLETE` batch with failed pages is a partial
run, not a failed one.

**Generated data is a draft until it is published.** `nxis publish` makes it live. Since that
changes what the site serves publicly, it asks first, like `autofill submit`: it counts what would
publish (and how much is already live), shows the count, and asks. Without a terminal, it exits `2`
(`confirmation_required`) with the count in the JSON (`published_count`, and the whole count as
`preview`); show it to the user, then run it again with `--yes`, which skips the count and the
question. When nothing would publish, it asks nothing and publishes nothing. `--dry-run` counts
what would publish without changing anything. It uses the tool's own dry run, which only
reads, so it does reach the server. The one exception: with no provisioning key stored yet, a dry
run cannot issue one, so it stops there and says so. Run `nxis autofill plan` once to issue it.

`crawl status` and `autofill status` with no arguments follow the last crawl and batch the CLI
started for the site. The CLI keeps those in `jobs.json`, next to its settings. `--batch <id>`
follows any other batch. With no batch saved, or with `--recent`, `autofill status` lists the
site's latest batches, newest first.

## Your site's MCP server and discovery documents

These act on the current site (`--site`, or the one `nxis sites use` saved).

**`nxis mcp public on|off`** makes the site's MCP server public, so agents can read its published
records without a key, and prints its endpoint. **`nxis mcp settings`** shows what is on: public,
listed in the NxisAI app, on-page agent, and where actions are routed. `--set` changes `public`,
`listed_in_app` or `on_page_agent` (`true`/`false`), each through the tool that owns it, and only
when it differs from what is set.

**Connections.** Agents and actions that send requests to the site's own servers (Quote, Booking,
an action's webhook) send them through a *connection*: a name, an https address and one signing
secret. Many routes can share one connection, so its address and secret are set in one place.

- **`nxis connections list`** shows each one: its name, address, the first characters of its
  secret (`secret_preview`), whether it is the site's default, and what uses it (`used_by.agents`,
  `used_by.action_types`).
- **`nxis connections create --name <name> --url <url> [--default]`** adds one. `--default` makes it
  the site's default, which every action and agent without a connection of its own uses.
- **`nxis connections rotate <name|id>`** issues a new secret. The old one stops working at once, for
  everything that uses the connection, so it asks first and names them; `--yes` skips the question
  once the user has agreed (without a terminal, it exits `2` with `confirmation_required` until then).
- **`nxis connections delete <name|id>`** deletes one, after asking. One still in use is refused with
  exit `2` (`connection_in_use`) and the agents it is used by: bind them elsewhere first.
- **`nxis connections test <name|id> [--action <type>] [--turn-on-checks]`** checks the receiver before agents depend
  on it. NxisAI, which alone holds the secret, sends one signed *check* call to the connection's
  address, signed exactly as real requests are (`X-Nxis-Signature`, `X-Nxis-Mode: check`,
  `"nxis:mode": "check"` and `"nxis:test": true` in the body, a fresh `Idempotency-Key`), with a
  minimal example of the action's arguments. A check commits nothing, so it doesn't ask first.
  It reports the `verdict`, `http_status`, `latency_ms`, `url`, the start of the answer's body
  (`body_excerpt`, never its headers), `answered_by` (who answered: `receiver`, or `tunnel`,
  `proxy` or `cdn` when one in front of the receiver answered with its own error page) and `next`,
  the step that fixes a failure:

  | Verdict | Meaning | Next step |
  |---|---|---|
  | `ok` | The receiver answered 2xx | Nothing: routes to it can reach it |
  | `signature_rejected` | It answered 401 or 403 | It reads a different secret than the connection's (or wasn't restarted since), or verifies a parsed and re-serialized body instead of the raw bytes |
  | `unreachable` | No answer: the name didn't resolve, nothing accepted the connection, or TLS failed | It isn't deployed at that address, or the tunnel to a local receiver is down |
  | `unreachable`, `answered_by` `tunnel`, `proxy` or `cdn` | A tunnel (ngrok), proxy or CDN answered with its own error page, such as ngrok's 502: the call never got to the receiver | The tunnel or host is up, but not reaching your server: check it is running and listening on the port the tunnel points at (for ngrok, `http://127.0.0.1:4040/api/tunnels` lists each tunnel's target), then test again |
  | `timeout` | No answer within 10 seconds | A check should answer at once without committing anything |
  | `bad_response` | Any other status, a redirect included | It got the call and didn't accept it; the excerpt shows what it said |

  It also says whether the receiver **answers availability checks** (`answers_checks`: a 2xx with
  JSON holding a boolean `available`), whether a booking check listed open times or a hold
  (`returned_windows`, `returned_hold`), and which routes on the connection have check support off
  (`check_support_off`: `default`, `QuoteAction` …). Agents on a route without it don't check first:
  Booking takes visit requests to confirm instead of offering open times, and Quote skips the
  service-area check. When the receiver answers checks and some routes have it off, the CLI asks on a
  terminal whether to turn it on; elsewhere `next` gives the command. `--turn-on-checks` turns it on
  without asking (`check_support_turned_on` lists the routes). Routes made after a passing test,
  such as an agent enabled with `--connection`, start with check support on.

  It exits `0` on `ok` and `2` on any other verdict (`connection_test_failed`, with the result in
  `--json`). One test per connection every few seconds: a sooner one exits `1` (`rate_limited`,
  with `retry_after_seconds`).

The signing secret is shown **once**, in the answer to `create` and to `rotate` (`signing_secret` in
`--json`): store it where the receiving application reads its configuration (for example
`NXIS_ACTION_SECRET`). It is in no other output: not in `list`, not in an error, never in the
`--verbose` trace, and the CLI does not keep it. A name or id that matches no connection exits `2`
(`connection_not_found`) with the names there are; a name already used exits `1`
(`connection_name_taken`); an unverified site exits `2` (`site_not_verified`); an environment that
doesn't offer connections yet exits `1` (`connections_unavailable`).

**`--write-env <file>`** (with `create` or `rotate`) keeps the secret out of the terminal and the
transcript: it is written into that env file as `NXIS_ACTION_SECRET`, or the variable
`--env-name` names, and not shown. The variable's line is replaced when the file has one, else
appended; every other line is kept. A new file is created readable by its owner only (mode
`600`), and an existing one is made so. The answer says where (`written_to`, `env_name`,
`secret_preview`, and `git`: `ignored` or `not_a_repository`). Before the secret is issued, the
file is checked, and refused with exit `1`:

| Reason | When |
| --- | --- |
| `env_file_tracked` | git tracks the file, so the secret would be committed |
| `env_file_not_ignored` | the file is in a git repository, and git doesn't ignore it (add it to `.gitignore`) |
| `env_dir_missing` | the file's directory doesn't exist |
| `env_file_not_regular` | the path is a directory or a link |
| `git_unavailable` | the file is in a repository and git can't be run to check it |

If the file can't be written once the secret exists, the command fails with `env_write_failed`
(exit `1`), without the secret: run `connections rotate <name> --write-env <file> --yes` for a new one.

**`nxis actions bind <action|booking|default>`** routes an action's submissions (`reserve`, `quote`,
`apply` …), the Booking agent's requests (`booking`), or every action (`default`):

- `--connection <name|id>` sends them through a connection. `--supports-check` (or
  `--supports-check=false`) goes with it on any route: the receiver answers availability checks, so
  agents check first. Booking's `--availability-url <url>`, the address free times are read from, on
  the connection's host, is refused on a route other than `booking`, `schedule` or `reserve`. Left
  out, each stays as it is; an empty URL clears it.
- `--webhook <url>` reuses the connection with that address, keeping its secret, or creates one named
  from the host (`hooks.example.com`, or `hooks.example.com 2` when that name is taken) and shows its
  new secret once, as `create` does (`connection_created: true`, `signing_secret`).
- `--self-page` sends them to the page that hosts the action, and `--gateway` to a gateway, which is
  set up in the dashboard (the CLI says so).

The `--json` answer of a connection route has the `connection`, a `binding`
(`connection_id`, `connection_name`, `url`, `method`), `webhook_host`, and the site's `connections`
as they now are.

**`nxis actions off`** stops generating the site's action tools, and **`nxis actions on`** turns
them back on. Neither touches the routes: every binding, override and webhook signing secret is
kept, so no new secret is issued. Asking for the state actions are already in changes nothing
(`changed: false`); `off` on a site with no MCP settings is already off (`configured: false`).
`on` with no route bound exits `2` (`nothing_bound`) with what to bind first, such as
`nxis actions bind default --self-page`. An unverified site exits `2` (`site_not_verified`), as
`bind` does, and `--dry-run` withholds both.

**`nxis discovery files`** prints the site's discovery documents (`llms.txt`, `agents.md`,
`.well-known/ai-catalog.json`, `.well-known/mcp/catalog.json`) with their paths. `--write` merges
them into the site's public root: `--out <dir>`, or `public/` or `static/` when exactly one of them
exists (build folders such as `dist/` are never chosen). Nothing is overwritten:

- JSON catalogs keep every entry and field. The site's entry is added, or, when an entry already
  points at the site's MCP endpoint, filled in where it lacks fields, keeping its titles.
- `llms.txt` keeps its title, summary and sections; a missing section is appended, and an existing
  one gains only the links it lacks.
- `agents.md` keeps its content and gains the generated guide as one section, if it lacks it.
- A catalog that is not valid JSON is reported, and nothing is written.
- Only those four paths are written. Any other path the server names is refused (`unsafe_path`),
  and nothing is written.

The files are written, then a unified diff of every change is printed; with `--dry-run`, only the
diff, and nothing is written. A second run changes nothing. Deploy afterwards: nothing is
discoverable until the files are live.

**`nxis types`** and **`nxis query <type>`** read the site's published records from its own MCP
endpoint, without a key, so they need `nxis mcp public on` first (`site_mcp_not_public` or
`site_mcp_off`, exit 2, otherwise). Generated drafts do not show up until they are published.
`--filter path=op:value` takes `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `in` (comma
separated) and `exists`, or the full operator names. `--text` runs a semantic search, which is
billed to the site's organization.

A filter value is sent with the JSON type the field is stored with. The server matches `eq`, `ne`
and `in` only against a stored value of the same type, so the number `48067` never matches a ZIP
code stored as the text `"48067"`, and structured data stores numbers as text about as often as
not. So:

- A quoted value is always text: `address.postalCode=eq:"48067"`.
- For `eq`, `ne` and `in`, an unquoted value that looks like a number or `true`/`false` is sent
  as the field holds it. The CLI first reads up to 5 records of the type that have the field (a
  plain lookup, not billed): text if any of them holds text, a number or a boolean if all of them
  do. With no record to sample, it is sent as a number (or boolean). For `in`, this applies to
  each value. Each field is read once per command.
- `gt`, `gte`, `lt` and `lte` send numbers as numbers, with no read first: the server compares
  those against both spellings.

The JSON output's `filter_types` says what each sampled field was found to be
(`{"address.postalCode": "string"}`; `"unknown"` when nothing settled it), and `--verbose` says so
on stderr.

## Authentication

`nxis login` uses the OAuth device flow by default. It prints a URL and a short code; open the URL
in any browser, confirm the code matches, and sign in. This works in containers, SSH sessions and
cloud dev boxes, and an agent can relay the URL and code without ever handling a credential.

`nxis login --web` instead opens a browser on the same machine and completes sign-in through a
local redirect using PKCE.

You rarely need to run `nxis login` first. On a terminal, a command that needs a sign-in offers
one (`Sign in now? [y/N]`), shows the same link and code, waits, and then runs again, once. With
`--json`, `--yes`, or no terminal, it stops with exit `3` and `signed_out` instead, as a script
expects.

Sign-in is handled by Auth0. Access tokens are refreshed automatically when they expire.

## Credentials

Tokens are stored in the OS keychain (`security` on macOS, `secret-tool` on Linux). Where no
keychain is available, or when `NXIS_NO_KEYCHAIN=1` is set, they are stored in
`~/.config/nxis/credentials.json` (or `$XDG_CONFIG_HOME/nxis/credentials.json`) with mode 0600.
The active organization and site, and the last `--api` value, are kept in `config.json` in the
same directory.

The CLI's own provisioning key, which it mints the first time a command needs the provisioning
endpoint, is kept in the keychain as well, in an entry of its own for each environment and
organization (`provisioning:…`, next to the tokens' `default`). Without a keychain it goes to
`provisioning-keys.json` in the same directory, also mode 0600. It is never written into a
project. `nxis logout` forgets it along with the tokens. When the provisioning endpoint refuses
it, the CLI revokes it by its id before minting another, so a key refused by mistake (a transient
failure, or a proxy) doesn't stay valid with nothing tracking it. If revoking fails, the renewal
goes ahead and the CLI says so; `--verbose` shows the outcome either way. It renews at most once a
minute for an environment and organization.

Tokens are never printed, not in `--json` and not in errors. With `mcp install --remote`, the MCP
key is written straight into the agent's config and reported only as a short preview; `--print` is the deliberate exception,
for configuring a client by hand. For Claude Code, the key is briefly in the arguments of
`claude mcp add`; see [The MCP server: local or remote](#the-mcp-server-local-or-remote). Outside production, MCP keys are issued as development keys
(`nxis_dev_mcp_…`), so a test run never leaves a live credential in a config file.

## Environment variables

| Variable | Effect |
|----------|--------|
| `NXIS_API` | Base URL for every service, same as `--api` |
| `NXIS_TOKEN` | Use this access token; it is never written to disk or refreshed |
| `NXIS_DPA_URL` | Where the data processing agreement for hosted agents is published, each version at `<url>/<version>` (default `https://nxis.ai/dpa`); an http or https URL. Only links are made from it; nothing is sent there |
| `NXIS_SITES_URL` | Base URL for the sites service, where `nxis agents` reads and writes the hosted agents' settings (default `https://sites.nxis.ai`, or the `--api` base URL) |
| `NXIS_NO_BROWSER=1` | Print URLs, never launch a browser |
| `NXIS_NO_KEYCHAIN=1` | Store credentials in a 0600 file instead of the OS keychain |
| `NXIS_RELEASES_URL` | Where `nxis update` and the installer look for releases (default `https://github.com/nxisai/cli/releases`); https only, or http to this machine |
| `NXIS_SITE_MCP_URL` | The site MCP endpoint that `nxis_list_types` and `nxis_query` are read from, instead of the one the provisioning endpoint reports for the site. Without it, against a stack other than production (`--api`, `NXIS_MCP_URL`) they are read from that stack's `/tenant/<site MCP host>/mcp` |

`--api` and `NXIS_API` must be `https://` URLs; plain `http://` is accepted only for this machine
(`localhost`, `127.0.0.1`, `[::1]`). Anything else is refused when it is read, rather than failing
later as a bad request. An explicit `--api` is remembered for subsequent commands, each of which says
so on stderr; `--api production` forgets it. Setting it marks the environment as non-production, and
the CLI then issues development keys instead of live ones.

A sign-in belongs to the environment it was made in. Credentials are only ever sent to the services
they were obtained for; pointing the CLI somewhere else asks you to sign in there
(`environment_mismatch`, exit 3) rather than sending them.

## Development

```bash
npm install
npm run build      # compile to dist/
npm test           # run the test suite
npm link           # put your local build on the PATH as `nxis`
```

`npm run typecheck` checks types without emitting. The build embeds `NXIS_AUTH_CLIENT_ID` from
the environment when it is set; without it the build still works, but can only sign in if the
variable is set at runtime. Publishing requires it: `npm publish` refuses to run unless
`NXIS_AUTH_CLIENT_ID` is set at build time.

The client id is a public identifier, not a secret. It is named for what it is rather than for
the provider that issues it, so that changing provider does not change what a build sets.

Each NxisAI tool the CLI calls is defined once in `src/tools/`, with the server's own name,
description and input schema. The tests compare those definitions with
`test/fixtures/provisioning-tools.json`, a recording of what the endpoints list. After a server
change, re-record it with a signed-in CLI, then fix whatever definition the tests name:

```bash
npm run build
node scripts/record-tools.mjs --site <id|domain>   # --site records the site endpoint's tools too
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The license covers this source code. It does not grant rights to the NxisAI name, the `nxis`
command name, or the logo — see [TRADEMARK.md](TRADEMARK.md), which also explains what you may
always say truthfully about a fork. It does not grant access to the NxisAI API either; that is
governed by the terms you agree to when you sign up.

The published package bundles no third-party code. Its two runtime dependencies, the MCP SDK and
`zod`, are installed from npm under their own MIT licenses. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
