# Releasing the standalone build

How a version gets from a tag to `install.sh`, `nxis update` and Homebrew, and the one-time setup
it needs. npm publishing is in [.github/workflows/publish.yml](../.github/workflows/publish.yml)
too; this page is about the rest.

## What a release is

A version tag `v<version>` on [nxisai/cli](https://github.com/nxisai/cli) runs `publish.yml`, which:

1. builds every platform's tarball and `install.sh` (`release/build.mjs`), with no secrets;
2. starts each tarball on its own platform's runner, with no node on PATH
   (`release/smoke-tarball.sh`);
3. after approval in the `npm` environment, signs the release (`release/sign.mjs`), checks it
   (`release/verify.mjs`, `release/check-public.mjs`), and attaches it to the tag's GitHub release,
   published as latest;
4. writes the Homebrew formula from the signed manifest (`release/formula.mjs`) and pushes it to
   [nxisai/homebrew-cli](https://github.com/nxisai/homebrew-cli), the tap `nxisai/cli`. This step
   is off until the tap is set up (see [Turning on the tap](#turning-on-the-tap)).

The GitHub release holds, for `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`:

| File | What it is |
|---|---|
| `nxis-<v>-<platform>.tar.gz` | Node.js (pinned in `release/node.json`), the bundled CLI, a launcher |
| `nxis-<v>-<platform>.tar.gz.sha256` | Its sha256, for people; nothing trusts it |
| `manifest.json` | Every tarball's and `install.sh`'s sha256 and size |
| `manifest.json.sig` | An Ed25519 signature over `manifest.json`'s exact bytes, base64 |
| `install.sh` | The installer, carrying the release keys and Node.js's hashes |

The installer and `nxis update` find the latest version through
`https://github.com/nxisai/cli/releases/latest/download/manifest.json`, then fetch that version's
files from `releases/download/v<v>/`. GitHub's `latest` skips pre-releases, so the GitHub release
is never marked one, even for a beta (npm still gets the `beta` dist-tag).

## One-time setup

### 1. The signing key

Make the key pair on a trusted machine, outside any git checkout. Only the public key is printed:

```bash
git clone https://github.com/nxisai/cli && cd cli && npm ci
node release/keygen.mjs ~/nxis-release-keys/release-2026.pem
```

Then:

1. Pin the public key: in `src/release-keys.ts`, replace the placeholder in `RELEASE_KEYS` with
   it, with a comment naming it and the date; update the test in
   `test/release-signing.test.ts` that expects only the placeholder; commit.
2. Store the private key as a secret of the `npm` environment in nxisai/cli, and nowhere else
   in GitHub:

   ```bash
   gh secret set NXIS_RELEASE_SIGNING_KEY --env npm -R nxisai/cli < ~/nxis-release-keys/release-2026.pem
   ```

3. Keep an offline copy (a password manager or an encrypted drive), then delete the file:
   `rm ~/nxis-release-keys/release-2026.pem`.

Until the key is pinned, `release/sign.mjs` refuses to sign, so the GitHub release job fails and
nothing is attached.

### 2. The tap

The `homebrew` job runs only when the repository variable `HOMEBREW_TAP_ENABLED` is `true` in
nxisai/cli. Without it the job is skipped, and npm and the GitHub release go ahead as usual.

#### Turning on the tap

1. Create the public repository `nxisai/homebrew-cli`, with a `main` branch (an initial README is
   enough; the workflow replaces it).
2. Make a deploy key that can write to it, and give its private half to the `npm` environment:

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'nxisai/cli publish' -f /tmp/homebrew-cli-deploy
   gh repo deploy-key add /tmp/homebrew-cli-deploy.pub -R nxisai/homebrew-cli --allow-write -t 'nxisai/cli publish'
   gh secret set HOMEBREW_TAP_DEPLOY_KEY --env npm -R nxisai/cli < /tmp/homebrew-cli-deploy
   rm /tmp/homebrew-cli-deploy /tmp/homebrew-cli-deploy.pub
   ```

3. Turn the job on:

   ```bash
   gh variable set HOMEBREW_TAP_ENABLED --body true -R nxisai/cli
   ```

### 3. The `npm` environment

It already gates npm. The GitHub release and the tap jobs use it too, so one approval covers all
three. Its deployment rule has to allow tags `v*.*.*`, and its required reviewers are added when
the repository goes public (GitHub offers them only for public repositories on this plan).

## While nxisai/cli is private

The workflow still makes the GitHub release, but its files need authentication to download, so
`curl … | sh` and Homebrew can't fetch them, and the formula is written (and printed in the job's
log) but not pushed. To try a release meanwhile, download it with your own GitHub credentials and
install from the folder:

```bash
gh release download v0.2.0 -R nxisai/cli -D /tmp/nxis-release
sh /tmp/nxis-release/install.sh --from /tmp/nxis-release
nxis update --check                   # fails while private: the latest manifest needs authentication
nxis update --from /tmp/nxis-next     # a newer release, downloaded the same way
```

## When nxisai/cli goes public

- Add the `npm` environment's required reviewers before the next tag.
- `curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh` works
  without signing in, in a clean shell, on macOS and in Linux (and in WSL).
- `nxis update --check` reaches the latest release.
- Once the tap is turned on, re-run the latest release's Publish workflow (or tag the next
  version) so the formula is pushed; then `brew tap nxisai/cli && brew install nxis` and the tap's
  own CI pass.

## Rotating the signing key

A key is trusted only by installs that have it pinned, so a new key ships before it signs anything:

1. Make the new pair (`release/keygen.mjs`) and add its public key to `RELEASE_KEYS`, keeping the
   old one. Release that version, signed with the **old** key: every install that updates to it
   now trusts both.
2. Replace `NXIS_RELEASE_SIGNING_KEY` with the new private key. Later releases are signed with it.
3. After a while, remove the old public key in a release.

If the old key is compromised, remove it in step 1 instead, and say so in the release notes:
installs older than that release can't verify the next one, and need the installer run again.

## Moving to a new Node.js

```bash
node release/node-hashes.mjs 24.22.3     # with gpg and Node's release keys imported
```

It writes `release/node.json` from nodejs.org's signed `SHASUMS256.txt`; commit it. The build
checks each download against it, and the installer checks the binary before using it.

## Trying it on your machine

```bash
npm run release:build -- --platforms host            # dist/release/download/v<v>/…
sh release/smoke-tarball.sh dist/release/download/v*/nxis-*.tar.gz
```

To install it, sign it with a throwaway key (the release can't be published that way: verify.mjs
refuses it):

```bash
node release/keygen.mjs /tmp/nxis-test-key/test.pem      # prints the public key, K
npm run release:build -- --platforms host --trust-key "$K"
node release/sign.mjs --key /tmp/nxis-test-key/test.pem --trust-key "$K"
sh dist/release/download/v*/install.sh --from dist/release/download/v*
rm -r /tmp/nxis-test-key
```
