# Contributing

This repository is public so you can read the CLI, audit what it does with your credentials,
and build it yourself. Thank you for being here.

## What helps right now

Issues. Genuinely — they are the most useful thing you can send us today:

- **Bugs.** A command that fails, hangs, or does the wrong thing.
- **Unclear errors.** If a message told you something went wrong but not what to do about it,
  that is a bug in our writing and we want to hear it.
- **Platform breakage.** Windows paths, Linux without a keyring, a container with no browser,
  an unusual shell.
- **Documentation that is wrong.** Including this file.

A good bug report beats a patch we cannot merge yet.

## What we are not accepting yet

**Pull requests.** Not because we do not want the help, but because the API this CLI talks to is
still moving and we would be wasting your time.

That is not a hypothetical. In a single week the token audience changed, every `NXIS_AUTH0_*`
environment variable was renamed, and the `--json` reason codes changed with them. A patch
written against any given week can be invalidated by the next one, through no fault of yours.
Asking people to write code against that would be discourteous.

When the surface settles, this changes. See [Later](#later).

## If you open a pull request anyway

It will be closed, with thanks and a link back here. Nothing more than that — no judgement, and
it does not count against you.

If the underlying fix is right, we will implement it and credit you by name in `CHANGELOG.md`.
So the most effective thing to do is open an issue describing the problem and, if you like, what
you think the fix is. That gets your name on the change without either of us pretending the PR
could be merged.

## Later

**We do not have a date yet.** We would rather say that than invent one.

What has to be true before pull requests open:

- The API surface has held still for a full release cycle.
- Recorded fixtures and a mock server cover the main command paths, so a contributor can build
  and test without an account.
- A maintainer can commit to a stated review turnaround.

When those hold we will update this file, remove the automation that closes pull requests, and
label some real issues as good first ones.

## Sign-off

When contributions do open, this project uses the
[Developer Certificate of Origin](https://developercertificate.org/). It is a short statement
that you wrote the patch, or otherwise have the right to submit it under this project's license.

You certify it by signing off your commits:

```bash
git commit -s -m "fix: whatever you fixed"
```

which appends a line like `Signed-off-by: Your Name <you@example.com>`. You keep your copyright;
your contribution is licensed under Apache-2.0 like the rest of the repository. There is no
separate agreement to sign and nothing to fax.

## Security

**Do not open a public issue for a security problem.**

See [SECURITY.md](SECURITY.md) for how to report one privately. We would much rather hear about
it from you first than read about it at the same time as everyone else.

## License

By participating you agree that your contributions are licensed under
[Apache-2.0](LICENSE), the same license as this repository.
