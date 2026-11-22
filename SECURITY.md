# Security

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting instead:
[**Report a vulnerability**](https://github.com/nxisai/cli/security/advisories/new).
It opens a private thread visible only to you and the maintainers, and it works without you
needing an email address of ours or a PGP key.

Useful things to include, as far as you have them:

- What an attacker could do, not only what the code does.
- The version (`nxis --version`) and how you installed it.
- Steps to reproduce, or a proof of concept.
- Whether you have told anyone else.

If you cannot use GitHub's reporting for any reason, open an issue saying only that you have a
security report and would like a private channel — **no details** — and we will open one.

## What to expect

| | |
|---|---|
| We acknowledge | within 3 business days |
| We give an initial assessment | within 10 business days |
| We tell you our fix timeline | with that assessment |

If a report affects users, we will publish an advisory and credit you unless you would rather we
did not. If we disagree that something is a vulnerability, we will say so and explain why, rather
than letting the thread go quiet.

We ask for reasonable time to fix an issue before it is made public. We will not ask you to stay
quiet indefinitely, and we will not threaten anyone for reporting in good faith.

## Supported versions

This CLI is pre-1.0 and changes quickly. Only the latest published version is supported; fixes
go out as a new release rather than as patches to older ones.

## Scope

This repository holds the CLI only — the client you run on your own machine.

**In scope:** anything in this repository. Credential handling, token storage, what gets written
to disk or to an agent's configuration, dependency issues, and the release and build pipeline.

**Out of scope here, but still wanted:** flaws in the NxisAI services the CLI talks to. Report
those the same way and we will route them internally — the service code is not public, so this
is the right door to knock on.

## Things worth knowing before you report

Two behaviours look alarming and are intentional:

- **The client id compiled into the package is not a secret.** The CLI is a public OAuth client
  using the device authorization flow. A public client id is expected and documented; there is
  no client secret in the package, and there is nothing in a built artifact that would need
  rotating.
- **Credentials are stored in your OS keychain,** falling back to a `0600` file under your
  config directory when no keychain is available. `NXIS_NO_KEYCHAIN=1` selects the file
  deliberately.

If you have found something that contradicts either of those, we would very much like to know.
