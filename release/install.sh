#!/bin/sh
# Installs the NxisAI CLI, `nxis`, on macOS and Linux (and on Windows inside WSL):
#
#   curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh
#
# nxis comes with its own Node.js runtime, so it works whether or not Node.js is installed, and
# never touches yours. Everything goes into ~/.nxis, plus an `nxis` command in ~/.local/bin.
#
# Settings (environment variables):
#   NXIS_INSTALL_VERSION=0.1.0   install that version instead of the latest
#   NXIS_INSTALL_DIR=<dir>       where nxis lives (default ~/.nxis)
#   NXIS_BIN_DIR=<dir>           where the `nxis` command goes (default ~/.local/bin)
#   NXIS_NO_MODIFY_PATH=1        don't add the command's folder to your shell's PATH
#   NXIS_RELEASES_URL=<url>      where releases are (default below; https only)
#
# Or install from a folder that holds a release's files (manifest.json, manifest.json.sig and the
# tarball for this machine), such as one `gh release download` wrote:
#
#   sh install.sh --from <dir>
#
# Uninstall: rm -rf ~/.nxis ~/.local/bin/nxis. Run `nxis logout` first to remove the stored
# sign-in from the OS keychain; settings stay in ~/.config/nxis.
#
# Each release is signed. Before installing, this script checks the version's manifest.json
# against the release keys written in below, and the tarball against the sha256 in that manifest.
# This script is itself what you trust on a first install (it carries the keys), so fetch it over
# https; `nxis update` checks the same signature itself.
#
# Everything is inside main(), which runs on the last line, so a download cut off halfway runs
# nothing.

set -eu

RELEASES_URL="__NXIS_RELEASES_URL__"
# The public keys releases are signed with (base64 Ed25519, from src/release-keys.ts).
RELEASE_KEYS="__NXIS_RELEASE_KEYS__"
# The sha256 of the Node.js binary inside each platform's tarball (release/node.json). That Node
# checks the release's signature, so it is checked first.
NODE_SHA256="__NXIS_NODE_SHA256__"

say() { printf '%s\n' "$*"; }
err() { printf 'nxis install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

fetch() { # fetch <url> <file>
  if has curl; then
    if [ "$secure" = 1 ]; then
      curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1" || err "couldn't download $1"
    else
      curl -fsSL --retry 3 -o "$2" "$1" || err "couldn't download $1"
    fi
  elif has wget; then
    if [ "$secure" = 1 ]; then wget -q --https-only -O "$2" "$1" || err "couldn't download $1"
    else wget -q -O "$2" "$1" || err "couldn't download $1"; fi
  else
    err "needs curl or wget"
  fi
}

# Checks the release before anything in it is trusted. Run by a Node that is known (see main) with
#   <manifest.json> <manifest.json.sig> <version> <tarball name> <tarball file> <key>...
# it exits non-zero unless one of the keys signed the manifest, the manifest is for that version,
# and the tarball matches the sha256 the manifest gives it.
VERIFY_JS='
const c = require("crypto"), f = require("fs");
const [manifest, sig, version, name, file, ...keys] = process.argv.slice(1);
const fail = (s) => { console.error("nxis install: " + s); process.exit(1); };
const body = f.readFileSync(manifest);
const s = Buffer.from(f.readFileSync(sig, "utf8").trim(), "base64");
const signed = keys.some((k) => {
  try { return c.verify(null, body, c.createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), s); }
  catch (e) { return false; }
});
if (!signed) fail("the release is not signed by an NxisAI release key; nothing was installed");
const m = JSON.parse(body);
if (m.name !== "nxis" || m.version !== version) fail("the signed manifest is for " + m.version + ", not " + version);
const want = m.files && Object.prototype.hasOwnProperty.call(m.files, name) ? m.files[name].sha256 : "";
if (!want) fail("nxis " + version + " has no " + name);
const got = c.createHash("sha256").update(f.readFileSync(file)).digest("hex");
if (got !== want) fail("the download does not match the signed manifest; try again");
'

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else err "needs sha256sum or shasum to check the download"; fi
}

is_musl() {
  [ -f /etc/alpine-release ] && return 0
  ls /lib/ld-musl-* >/dev/null 2>&1 && return 0
  (ldd --version 2>&1 || true) | grep -qi musl
}

platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin
      # A shell running under Rosetta reports x86_64 on Apple silicon; install the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi ;;
    Linux) os=linux
      if is_musl; then
        err "this Linux uses musl (Alpine, for one), and nxis's standalone build needs glibc.
Install nxis from npm instead, with Node.js 20 or later:

  npm i -g @nxisai/cli"
      fi ;;
    # Git Bash, MSYS2 and Cygwin on Windows. nxis runs on Windows inside WSL, which is Linux.
    MINGW* | MSYS* | CYGWIN*)
      err "on Windows, install nxis inside WSL:

  1. In PowerShell, run: wsl --install
  2. Restart if asked, then open Ubuntu from the Start menu.
  3. Run this install command again in the Ubuntu terminal.

With Node.js 20 or later on Windows itself, \`npm i -g @nxisai/cli\` works too." ;;
    *) err "$os isn't supported: nxis installs on macOS, Linux, and Windows with WSL (or anywhere with Node.js 20+: npm i -g @nxisai/cli)" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) err "$arch processors aren't supported by the standalone build; with Node.js 20 or later, run: npm i -g @nxisai/cli" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# Adds `export PATH=...` for the bin folder to the user's shell startup file, once.
add_to_path() {
  dir=$1
  case ":$PATH:" in *":$dir:"*) return 0 ;; esac
  if [ "${NXIS_NO_MODIFY_PATH:-}" = 1 ]; then
    say "Add $dir to your PATH to run nxis."
    return 0
  fi
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$dir:\$PATH\"" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\"" ;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$dir\"" ;;
    *) rc="$HOME/.profile"; line="export PATH=\"$dir:\$PATH\"" ;;
  esac
  if [ -f "$rc" ] && grep -qF "$dir" "$rc"; then return 0; fi
  mkdir -p "$(dirname "$rc")"
  printf '\n# nxis\n%s\n' "$line" >>"$rc"
  say "Added $dir to your PATH in $rc. Open a new terminal, or run: $line"
}

# A path that goes into the launcher, between double quotes.
plain_path() {
  case "$1" in /*) ;; *) err "$2 has to be an absolute path: $1" ;; esac
  case "$1" in *[\"\`\$\\]*) err "$2 can't contain quotes, backticks, \$ or backslashes: $1" ;; esac
}

main() {
  from=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) [ $# -ge 2 ] || err "--from needs a folder"; from=$2; shift 2 ;;
      --from=*) from=${1#--from=}; shift ;;
      -h | --help) say "usage: install.sh [--from <dir>]  (settings: NXIS_INSTALL_VERSION, NXIS_INSTALL_DIR, NXIS_BIN_DIR, NXIS_NO_MODIFY_PATH, NXIS_RELEASES_URL)"; return 0 ;;
      *) err "unknown option $1 (try --from <dir>)" ;;
    esac
  done
  from=${from:-${NXIS_INSTALL_FROM:-}}

  url="${NXIS_RELEASES_URL:-$RELEASES_URL}"
  url=${url%/}
  # https only, redirects included; plain http only to this machine, for a local test release.
  case "$url" in
    https://*) secure=1 ;;
    http://localhost:* | http://localhost/* | http://localhost | http://127.0.0.1:* | http://127.0.0.1/* | http://127.0.0.1 | 'http://[::1]'*) secure=0 ;;
    *) err "NXIS_RELEASES_URL has to be an https URL: $url" ;;
  esac
  case "$url" in *[\"\`\$\\\ ]*) err "NXIS_RELEASES_URL can't contain quotes, backticks, \$, backslashes or spaces" ;; esac

  target=$(platform)
  install_dir="${NXIS_INSTALL_DIR:-$HOME/.nxis}"
  bin_dir="${NXIS_BIN_DIR:-$HOME/.local/bin}"
  plain_path "$install_dir" NXIS_INSTALL_DIR
  plain_path "$bin_dir" NXIS_BIN_DIR

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t nxis)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  # The version: asked for, or the latest release's (whose manifest is checked below like any).
  version="${NXIS_INSTALL_VERSION:-}"
  version=${version#v}
  if [ -z "$version" ]; then
    if [ -n "$from" ]; then
      [ -f "$from/manifest.json" ] || err "$from has no manifest.json"
      cp "$from/manifest.json" "$tmp/latest.json"
    else
      fetch "$url/latest/download/manifest.json" "$tmp/latest.json"
    fi
    version=$(sed -n 's/^  "version": "\([^"]*\)",\{0,1\}$/\1/p' "$tmp/latest.json" | head -n 1)
  fi
  case "$version" in "" | *[!0-9A-Za-z.+-]*) err "couldn't tell which version to install (got '$version')" ;; esac

  name="nxis-$version-$target"
  say "Installing nxis $version ($target)…"
  if [ -n "$from" ]; then
    for f in manifest.json manifest.json.sig "$name.tar.gz"; do
      [ -f "$from/$f" ] || err "$from has no $f"
      cp "$from/$f" "$tmp/$f"
    done
  else
    fetch "$url/download/v$version/manifest.json" "$tmp/manifest.json"
    fetch "$url/download/v$version/manifest.json.sig" "$tmp/manifest.json.sig"
    fetch "$url/download/v$version/$name.tar.gz" "$tmp/$name.tar.gz"
  fi

  # The Node to check the signature with: the one in the tarball, once it matches the hash pinned
  # above (only that one file is unpacked for this); otherwise, for a version that ships another
  # Node, the node on your PATH.
  mkdir "$tmp/check"
  node_bin=""
  want_node=$(printf '%s\n' $NODE_SHA256 | sed -n "s/^$target=//p")
  if tar -xzf "$tmp/$name.tar.gz" -C "$tmp/check" "$name/bin/node" 2>/dev/null &&
    [ -n "$want_node" ] && [ "$(sha256 "$tmp/check/$name/bin/node")" = "$want_node" ]; then
    node_bin="$tmp/check/$name/bin/node"
  elif has node; then
    node_bin=node
  else
    err "can't check nxis $version's signature: it ships a Node.js this script doesn't know, and there's no node on your PATH. Install the latest version instead."
  fi
  # shellcheck disable=SC2086 # one argument per key
  "$node_bin" -e "$VERIFY_JS" "$tmp/manifest.json" "$tmp/manifest.json.sig" "$version" "$name.tar.gz" "$tmp/$name.tar.gz" $RELEASE_KEYS ||
    exit 1
  rm -rf "$tmp/check"
  say "Checked the signature and checksum."

  mkdir -p "$install_dir/versions" "$bin_dir"
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  if [ ! -x "$tmp/$name/bin/node" ] || [ ! -f "$tmp/$name/app/dist/nxis.mjs" ]; then err "$name.tar.gz is missing files"; fi
  rm -rf "$install_dir/versions/$version"
  mv "$tmp/$name" "$install_dir/versions/$version"
  touch "$install_dir/versions/$version" # newest first when old versions are cleaned up below
  # `current` switches in one step, so an nxis that's running keeps working until it exits. A
  # plain mv would follow the old link into its folder, so rename the link itself: -T on GNU, -h
  # on macOS and BSD.
  ln -sfn "versions/$version" "$install_dir/current.tmp"
  if mv -T "$install_dir/current.tmp" "$install_dir/current" 2>/dev/null; then :
  elif mv -h "$install_dir/current.tmp" "$install_dir/current" 2>/dev/null; then :
  else rm -f "$install_dir/current.tmp"; ln -sfn "versions/$version" "$install_dir/current"; fi
  [ "$(readlink "$install_dir/current")" = "versions/$version" ] || err "couldn't switch to $version in $install_dir"

  # The command: a small launcher with fixed paths, so it survives updates, and so what
  # `nxis mcp install` writes into an agent's config keeps working after one.
  cat >"$bin_dir/nxis.tmp" <<EOF
#!/bin/sh
# nxis launcher, written by the nxis installer. nxis runs on its own Node.js in $install_dir/current.
# NXIS_LAUNCHER, NXIS_INSTALL_DIR and NXIS_RELEASES_URL tell nxis how it was installed, for nxis update.
NXIS_LAUNCHER="$bin_dir/nxis" NXIS_INSTALL_DIR="$install_dir" NXIS_RELEASES_URL="$url" \\
  exec "$install_dir/current/bin/node" "$install_dir/current/app/dist/nxis.mjs" "\$@"
EOF
  chmod +x "$bin_dir/nxis.tmp"
  mv -f "$bin_dir/nxis.tmp" "$bin_dir/nxis"

  # Keep this version and the one before it; remove older ones. The folders are versions this
  # script checked (digits, letters, dots, + and -), so ls is safe here, and it sorts by time.
  # shellcheck disable=SC2012
  for old in $(ls -1t "$install_dir/versions" | tail -n +3); do rm -rf "$install_dir/versions/$old"; done

  installed=$("$bin_dir/nxis" --version 2>/dev/null) || err "nxis was installed but didn't start; please report this"
  [ "$installed" = "$version" ] || err "installed $version, but nxis reports $installed; please report this"
  say "Installed nxis $installed in $install_dir"
  add_to_path "$bin_dir"
  say ""
  say "Telemetry: this version of nxis sends none. If a later version adds usage reporting, its"
  say "README will say what it collects before that release ships, and DO_NOT_TRACK=1 will turn"
  say "it off."
  say ""
  say "Next: run \`nxis signup\` to sign in, then \`nxis mcp install\` to connect your coding agent."
  say "Update with \`nxis update\`."
}

main "$@"
