# nxisai/homebrew-cli

The Homebrew tap for [nxis](https://github.com/nxisai/cli), the NxisAI CLI.

```sh
brew tap nxisai/cli
brew install nxis
nxis signup        # sign in
nxis mcp install   # connect your coding agent
```

Update with `brew upgrade nxis`.

The formula installs the same signed release as the installer
(`curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh`): nxis with
the Node.js it runs on, for macOS and Linux, arm64 and x64. Each release's formula is written by
`release/formula.mjs` in [nxisai/cli](https://github.com/nxisai/cli) from that release's signed
manifest, and committed here by its release workflow. Don't edit `Formula/nxis.rb` by hand: the
next release replaces it.

Issues go to [nxisai/cli](https://github.com/nxisai/cli/issues). Report a vulnerability privately,
as [SECURITY.md](https://github.com/nxisai/cli/blob/main/SECURITY.md) describes.
