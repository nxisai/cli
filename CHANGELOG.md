# Changelog

Every release of `@nxisai/cli`. Each section becomes the release's commit message in
[nxisai/cli](https://github.com/nxisai/cli), so a release cannot be published without one.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). A pre-release version such as `0.1.0-beta.1` is
published under the `beta` dist-tag; a plain version, under `latest`.

## [Unreleased]

## [0.2.0-beta.1] - 2026-11-23

### Added

- **Every hosted agent by its catalog id.** `nxis agents enable <id>`, `configure <id>`,
  `disable <id>`, `pause <id> [--tools] [--reason <text>]` and `resume <id>` work for any agent
  NxisAI hosts (`page`, `support`, `quote`, `booking`, and agents added later), with flags read
  from the agent's own setup in the catalog, so a newly hosted agent needs no CLI update. Quote and
  Booking can now be turned on from the terminal: `nxis agents enable quote --label "Get a quote"
  --connection Website`. A list setting repeats (`--example a --example b`) and replaces the list;
  `configure --clear <setting>` returns one to its default. The NxisAI API now serves these
  commands.
- **`nxis agents catalog`** lists the agents NxisAI offers, with fit, readiness, whether NxisAI
  hosts each, whether the site has added it, its state and what it still needs (`--job`,
  `--industry`, `--readiness`, `--added`/`--not-added`, `--query`, `--by-fit`). `nxis agents
  catalog <id>` shows one agent's settings as flags with their limits, its prerequisites with their
  status, and the shortest `enable` line that works.
- Flags are checked before anything is sent, as the service checks them, with reasons built from
  the flag: `missing_<flag>`, `<flag>_too_long`, `too_many_<setting>` and `invalid_<flag>` (a
  flag's `-` written `_`, as in `invalid_slot_minutes`), plus `unknown_flag` and `model_retired`.
  The service's refusals map to `unknown_agent`, `agent_not_hosted`, `invalid_input` and
  `version_conflict` (exit `1`), and `connection_required` (listing the site's connections by
  name), `connection_not_found`, `connection_unusable`, `actions_off`, `records_missing` and
  `opening_hours_required` (exit `2`). Turning on an agent whose serve-time needs are unmet exits
  `0` with `state: "needs_setup"` and a `next` line.
- `nxis agents status --json` adds `agents`, one entry per hosted agent with its state, settings
  and pause.

### Changed

- Lengths are counted in UTF-16 code units, as the service counts them, so a label with emoji is
  refused before sending rather than by the service.
- `enable`, `disable`, `pause` and `resume` for `page` and `support` keep their flags, reasons and
  output keys. Against an environment without hosted agents by id, they keep the older path; any
  other id there fails with `hosted_agents_unavailable`. A flag that isn't one of an agent's
  settings is now refused (`unknown_flag`) instead of ignored.
- A list setting that takes each item once ignores case when it compares them, and a one-line
  setting or list item refuses a line break (`invalid_<flag>`), as the service does.

## [0.2.0-beta.0] - 2026-11-22

### Fixed

- **`nxis discovery files --write` adds the hosted agents' entry to `ai-catalog.json`.** For a site with hosted specialists, the server now generates a second entry, the edge's A2A agent list (`application/a2a-agent-list+json`). The merge used to take any generated entry for the MCP server card already in the file, so that entry was never added. Now an entry other than the server card is matched by its identifier or its own URL only.

### Added
- **Connections.** `nxis connections list | create --name <name> --url <url> [--default] |
  rotate <name|id> | delete <name|id>` manage a site's connections: a name, an https address and
  one signing secret, shared by the agents and actions that send requests to the site's own
  servers. The secret is shown once, as `signing_secret`, in the answer to `create` and `rotate`,
  and in no other output, error or trace. `rotate` and `delete` ask first (`--yes` once the user
  agreed). New reasons: `connection_not_found` and `connection_in_use` (exit `2`),
  `connection_name_taken` and `connections_unavailable` (exit `1`). The reason comes from the
  service's machine-readable reason (a `google.rpc.ErrorInfo` detail) when it sends one. Against a
  service that sends none, the CLI falls back to the wording of the message. A `connection_in_use`
  error lists the agents the service named under `used_by.agents`.
- **`nxis actions bind <action|booking|default> --connection <name|id>`** sends a route through a
  connection, with Booking's `--supports-check[=false]` and `--availability-url <url>`.
- **`nxis mcp serve` connection tools:** `nxis_list_connections`, `nxis_create_connection`,
  `nxis_bind_connection`, `nxis_rotate_connection_secret` and `nxis_delete_connection`. Creating,
  binding, rotating and deleting ask the user first, over elicitation, naming the connection and its
  host.
- `nxis agents` manages a site's hosted agents, the on-page assistant and the Support Agent, from
  the terminal: `status`, `enable page|support` (`--label`, `--description`, repeatable
  `--example`, `--model`), `disable page|support`, `pause [page|support] [--tools] [--reason <text>]` (the kill
  switch, for one agent or, with none named, the whole site), `resume [page|support]`, and `policy set <file.json | ->` / `policy show` for the guardrails policy.
  Changes reach the site within seconds. Each change writes back only what it changes and keeps
  every other setting; when nothing would change, nothing is sent (`"changed": false`). A change
  that races another one is retried once, then fails with `version_conflict`.
- `nxis agents transcripts` manages a site's hosted transcripts: `list [--limit n] [--page-token t]`,
  `show <id>`, `export [--out file] [--format json|csv] [--force]` (every page; CSV with the
  dashboard's columns and formula-injection guard), `delete <id>` and `delete --all` (asks first;
  `--yes` skips it), `settings [--retention-days n] [--dont-store | --store]`, and
  `webhook set <url> [--keep-secret]`, `webhook remove` and `webhook status`. `webhook set` makes
  the signing secret locally and prints it once; it is never saved or traced. `nxis agents status`
  shows the transcript settings.
- New `--json` reasons for transcripts: `invalid_limit`, `missing_transcript`,
  `invalid_transcript_id`, `transcript_not_found`, `invalid_format`, `missing_out`, `file_exists`,
  `write_failed`, `conflicting_flags`, `invalid_retention`, `missing_webhook_url`,
  `invalid_webhook_url` and `no_webhook_secret`.
- `nxis agents dpa` shows the data processing agreement for hosted agents: its current version,
  where to read it (`https://nxis.ai/dpa/<version>`, or under `NXIS_DPA_URL`), and who accepted it
  and when. `nxis agents dpa accept` shows the version and its link, asks, and accepts exactly that
  version; with no terminal it stops with `confirmation_required` (exit 2), the version and the
  link, until `--yes`. A version published in between is refused (`dpa_version_changed`, exit 2);
  with none published, `dpa_not_published` (exit 1). `nxis agents status` says when the agreement
  is what holds back going live (`live`, `dpa` and `go_live_blocked_by` in `--json`).
- The data processing agreement is accepted per organization: `nxis agents dpa accept` accepts for
  the organization, covering all of its sites. `--site <id> --entity "<name>"` accepts for a site
  that belongs to a different legal entity, for that site only; such a site then needs `--entity`
  (`dpa_entity_required`, exit 2), and a bad name is `invalid_entity` (exit 1). `nxis agents dpa`
  says whom it was accepted for (`accepted_for`, `legal_entity`, `organization_acceptances`).
- `nxis agents status` shows a site that wants to be live but waits on the agreement
  (`waiting_on_dpa`, with `live` false), and, in the 30 days after a new version, the date the
  earlier one keeps applying until (`dpa.grace_end`; also `grace_end` in `nxis agents dpa`).
- `--dry-run --json` now shows a request body with its secret fields redacted, as `--verbose` does.
- New `--json` reasons: `missing_agent`, `missing_label`, `label_too_long`,
  `description_too_long`, `too_many_examples`, `example_too_long`, `reason_too_long`,
  `invalid_policy`, `missing_policy_file`, `unknown_agent` and `version_conflict`.
- `nxis agents policy show` prints the version of NxisAI's instructions the on-page assistant
  follows, and `--instructions` prints them in full; `--json` has
  `instructions: {type, version, publish_time}` (and `text` with the flag). `nxis agents status`
  lists the organization's notices about this site's hosted agents that haven't been dismissed
  (`notices` in `--json`).
- `nxis agents policy set` refuses a policy with `systemPrompt` before sending it, since hosted
  agents follow NxisAI's instructions: exit 2, reason `system_prompt_not_settable`. The service's
  own refusal is reported the same way.
- `NXIS_SITES_URL` points the sites service somewhere else; `--api` and `NXIS_API` cover it too.
  Existing sign-ins are unaffected.

### Changed

- Homebrew isn't offered for now: install with the installer or npm. The README no longer lists
  `brew tap nxisai/cli`.
- **`nxis actions bind --webhook <url>` goes through connections.** It reuses the connection with
  that address, keeping its secret, or creates one named from the host and shows its secret once.
  Its `--json` answer now has `connection`, `connection_created`, `webhook_host`, `connections` and
  a `binding` of `connection_id`, `connection_name`, `url` and `method`, in place of
  `default_route`, `overrides` and `actions_enabled`. `signing_secret` and `secret_is_new` are there
  only when a connection was created.
- An HTTP failure's `--json` details carry the service's `rpc_code` when it sends one.

## [0.1.0-beta.3] - 2026-11-11

### Added
- `nxis keys create --scope content_gaps:report` mints a site key: an API key bound to one site
  of the organization (`--site`, or the current one) that can only report the site's content gaps
  and helpful counts. Every other surface refuses it. The site is checked against the
  organization's sites first. The key is shown once, and is in `--json` as `api_key`; the CLI
  doesn't keep it and `--verbose` never traces it. If the service hands back a key that isn't
  bound to the site and scope, the CLI revokes it at once and fails with `site_keys_unsupported`.
- `nxis keys list [--all]` lists the current site's keys you created, without their secrets.
- `nxis keys revoke <key-id>` revokes a key; it stops working on its next use. A key that's
  unknown or already revoked reports `already_gone`.
- New `--json` reasons: `missing_scope`, `unknown_scope`, `site_keys_unsupported` and
  `missing_key_id`.
- A standalone build for macOS and Linux (arm64 and x64), and Windows through WSL, with its own
  Node.js: `curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh`, or
  `brew tap nxisai/cli && brew install nxis`. Each release is signed; the installer checks the
  signature and checksum before it installs anything. On Git Bash, MSYS2 or Cygwin the installer
  points to WSL, and on musl Linux to npm.
- `nxis update` updates an install from the installer in place, after checking the new version's
  signature and checksum, and keeps the version it replaced (`--to <version>` goes back).
  `--check` only reports. For Homebrew and npm it prints the command that updates them. New
  `--json` reasons: `invalid_version`, `insecure_releases_url`, `update_check_failed`,
  `unverified_release` and `update_failed`.

### Changed
- `nxis mcp install` writes the standalone install's launcher (`~/.local/bin/nxis`, or Homebrew's
  `opt` path) into the agent's config, so the entry keeps working after an update.

## [0.1.0-beta.2] - 2026-11-07

Security hardening: `nxis mcp serve` asks before risky calls, and sitemap reads, discovery
writes and provisioning-key renewal are tightened.

### Security
- `nxis crawl submit` reads at most 50 MB of a sitemap, the sitemap protocol's limit, both as
  downloaded and once decompressed, so a small gzipped file that inflates to gigabytes can no
  longer exhaust memory. A larger sitemap, or a corrupt gzipped one, fails with `sitemap_invalid`.
- `nxis discovery files --write` writes only the discovery documents it knows: `llms.txt`,
  `agents.md`, `.well-known/ai-catalog.json` and `.well-known/mcp/catalog.json`. Any other path
  the server names, such as `index.html`, is refused with `unsafe_path`, and nothing is written.
- When the provisioning endpoint refuses the CLI's provisioning key, the CLI revokes that key by
  its id before minting another, instead of only forgetting it. A refusal that was transient, or
  came from a proxy, no longer leaves a valid key behind that nothing tracks. Revoking is best
  effort: a key the service no longer knows counts as revoked, and any other failure is reported
  without stopping the renewal. Renewals are limited to one a minute for each environment and
  organization; a refusal within that minute fails with `key_refused`.
- `nxis mcp serve` asks you before a call that spends credits or changes what the public sees:
  an autofill `submit`, a publish that isn't a dry run, turning the site's MCP server public,
  routing actions to a webhook, and listing the site in the NxisAI app. It asks
  over MCP elicitation, naming what's at stake: the plan's count and price, the records that
  would go live, the webhook's host, the site. Only an explicit accept goes ahead. A decline or a
  dismissal returns `declined_by_user` or `cancelled_by_user`, and nothing is sent. A client
  without elicitation gets `confirmation_unavailable`, with what the call would do and the
  terminal command that does it, unless the server runs with `--allow-unconfirmed`. Tool names
  and input schemas are unchanged.
- `nxis mcp serve --read-only` refuses every call that may change something. `mcp install`
  passes `--read-only` and `--allow-unconfirmed` on to the command it installs.
- `nxis mcp serve` lists accurate MCP annotations for every tool: `readOnlyHint`,
  `destructiveHint`, `idempotentHint` and `openWorldHint`. A result that binds a webhook states
  the webhook's host.

## [0.1.0-beta.1] - 2026-11-04

Site onboarding from the terminal: every step of the Site Onboarding skill as a command, and the
same steps as a local MCP server for an agent. Not published to npm: these changes first ship in
`0.1.0-beta.2`.

### Added
- The groundwork for the onboarding commands: a client for the organization's provisioning MCP
  endpoint, which the site, data and MCP commands will call.
- A provisioning key, minted on first need and kept in the OS keychain (or a 0600 file without
  one), one per environment and organization. It is never written into a project. When the
  endpoint refuses it, the CLI mints one more; `nxis logout` forgets it.
- `--site <id|domain>` to act on one site, and a saved site that `nxis status` shows. Switching
  organization forgets a site saved for another one.
- Flags that may be repeated, such as `--set a=1 --set b=2`.
- One definition for each NxisAI tool the onboarding uses, shared by the CLI's commands and the
  local MCP server to come: the server's own name, description and input schema, which inputs only
  read (so `--dry-run` still runs them), and the endpoint that serves it. Arguments are checked
  before anything is sent (`invalid_input`, naming the field), the site comes from `--site` or the
  saved one, and a domain is turned into the site's id.
- `nxis_list_types` and `nxis_query` are read from the site's own MCP endpoint, which needs its
  MCP server to be public; `NXIS_SITE_MCP_URL` points them elsewhere, for a local stack.
- `nxis crawl submit` and `nxis crawl status`: crawl the site's sitemap. Before submitting, every
  URL in it (following a sitemap index) must be on the site's own host; a deploy's generated host
  fails with an explanation. `--wait` polls until the crawl finishes.
- `nxis autofill plan`, `submit` and `status`: generate structured data, importing what pages
  already publish by default (`--existing import_and_complete`). `plan` shows the count, the
  breakdown and the balance, and never an estimated total. `submit` asks first (`--yes` skips the
  question; without a terminal it exits 2 with the plan), and submits once: on a timeout it reports
  what it can find rather than submitting again. A `PAUSED` batch is reported with how to buy
  credits, never resumed.
- `nxis publish`: make generated data live. Like `autofill submit`, it asks first, showing how
  many records would go live (`--yes` skips the question; without a terminal it exits 2 with the
  count). `--dry-run` only counts what would publish.
- A test that fails when the server's recorded tool schemas no longer match the definitions, and
  `scripts/record-tools.mjs` to re-record them.
- `nxis sites create|list|use|verify|name|list-in-app|tag`: the site steps of onboarding as
  commands. `create` saves the new site as current and names it with `--name`; `verify --token`
  returns the META tag (`--json`: `tag`, `name`, `content`); `verify --check` exits `2`
  (`site_not_verified`, with the verifier's reason) until the tag is live in production, and
  also exits `2` (`site_unreachable`) when the site cannot be fetched at all;
  `list-in-app --preview` shows how the NxisAI app would list the site without changing anything.
- A domain in `--site` or `nxis sites use` that matches no site's host exactly now finds a site
  that differs only by a leading `www.`; two or more matches are `site_ambiguous`, with the
  candidates.
- `nxis mcp public on|off` and `nxis mcp settings [--set key=value …]`: the site's MCP server,
  public or not, and its settings (`public`, `listed_in_app`, `on_page_agent`). On a site whose
  MCP server was never set up, `mcp settings` says so (`configured: false`) and shows the
  defaults; reading creates nothing.
- `nxis actions bind <action|default> --webhook <url> | --gateway | --self-page`: where an action's
  submissions go. A new webhook's signing secret is shown once, and never traced.
- `nxis actions on|off`: turn the site's action tools on or off without touching the routes; every
  binding, override and webhook signing secret is kept. `on` with nothing bound exits `2`
  (`nothing_bound`) with what to bind first; an unverified site exits `2` (`site_not_verified`).
- `nxis discovery files [--write] [--out <dir>]`: the site's discovery documents, printed, or merged
  into the project's public root, printing a diff of what changed (`--dry-run` prints it without
  writing). Existing entries, titles and sections are kept; `ai-catalog.json` and `llms.txt` are
  never overwritten; a second run changes nothing.
- `nxis types` and `nxis query <type> [--text …] [--filter path=op:value …] [--limit n]`: the
  site's published records, read from its own public MCP endpoint. For `eq`, `ne` and `in`, which
  the server matches only against a stored value of the same JSON type, an unquoted number or
  boolean is sent as the field is stored: one read of a few records that have the field decides
  (text if any holds text), and `filter_types` in the output says what it found. A quoted value is
  always text; the range operators need no read.
- `nxis mcp serve`: the onboarding tools as a local MCP server on stdio, under the same name
  (`nxis-onboarding`), tool names and schemas as the remote one. It runs each call with the CLI's
  sign-in and keychain key, takes `--org`, `--site` and `--api` as defaults, returns failures as
  `isError` results with the `--json` error object, and keeps stdout for the protocol alone.
- `nxis autofill submit` finds the batch a lost submit started. When the submit does not answer,
  the CLI lists the site's latest batches once (a read; it never submits again). A batch that
  started after the submit was sent, allowing a minute of clock skew, is reported as the one it
  started (`batch_id`, `batch`) and saved, so `nxis autofill status --wait` follows it. It still
  exits `2` (`submit_unconfirmed`). A server that cannot list batches gets the previous report.
- `nxis autofill status --recent`, and `autofill status` with no batch saved, list the site's
  latest batches, newest first.

### Changed
- The CLI's first runtime dependencies: `@modelcontextprotocol/sdk` and `zod`, both MIT.
- **`nxis mcp install` now installs the local server by default (`--stdio`)**: the agent's config
  gets the command `nxis mcp serve` (the installed `nxis` by its absolute path, else
  `npx -y @nxisai/cli@<version> mcp serve`, pinned to the version that ran the install) and no
  key, and no key is minted. `--remote` keeps the previous behaviour: mint a key and write the
  endpoint's URL and key. `--force` replaces an entry written by either.
- **A project `.mcp.json` is never committed**, since it can hold credentials. Whenever
  `mcp install` writes one, it adds `.mcp.json` to `.gitignore` unless git already ignores it, and
  reports it (`gitignored` in the JSON). It no longer refuses a not-yet-ignored `.mcp.json` for
  `--remote`; it ignores it instead. A `.mcp.json` git already tracks gets no key
  (`mcp_json_tracked`, exit 2, before a key is minted), and an entry without one comes with a
  warning: untrack it with `git rm --cached .mcp.json` and rotate any key committed in it.
  `--dry-run` writes nothing and says what would change.

### Fixed
- `nxis login`: when the sign-in is refused, the message gives Auth0's reason (a cancelled
  prompt, a refusing rule, an application that may not request the API) instead of always
  saying it was declined in the browser.
- `nxis types` and `nxis query`: when the site's own MCP endpoint refuses the request (401 or
  403), the CLI exits `2` with `site_mcp_not_public` and says to run `nxis mcp public on`, instead
  of `key_refused` sending you to `nxis login` for a key it never sent. The provisioning endpoint,
  which does get a key, still reports `key_refused`. `scripts/record-tools.mjs` says the same.

## [0.1.0-beta.0] - 2026-10-19

The first release. It rehearses the release pipeline and is not published to npm; `0.1.0-beta.2`
is the first version on npm.

### Added
- `nxis signup`: sign in, create or reuse an organization, and list the plans available.
- `nxis login` (device code, or `--web` for a browser redirect), `logout`, `whoami` and `status`.
- `nxis plans` and `nxis subscribe <tier>`: activate a free plan, or pay for a paid one and wait.
- `nxis credits`, `credits packs` and `credits buy <sku>`: the balance, and top-ups once a plan is
  active.
- `nxis orgs create | list | use | update`.
- `nxis mcp install`: issue an MCP key and write it into Claude Code, Cursor or `.mcp.json`,
  showing only a preview of it.
- `--json` on every command, with a stable `reason` on failure, and exit codes an agent can act
  on: `0` done, `2` needs the user, `3` not authorized, `1` failed.
- `--verbose` prints every request with credentials removed; `--dry-run` shows a change without
  making it.

### Security
- `nxis mcp install` no longer writes the MCP key into a file git would commit. Claude Code is
  configured at local scope, and `.mcp.json` is only written where git ignores it.
- Stored credentials are only sent to the services they were obtained for, and plain `http` is
  accepted for this machine only. `--api production` forgets a saved `--api`.
- Only `https` links are opened, and never through `cmd` on Windows. Links open in WSL.
- Keychain credentials are written through stdin, not the command line.
- Files holding a key or tokens are left readable by their owner only, even if they existed.
- `login --web` ignores callbacks without its own state, and control characters are stripped
  from server messages.
