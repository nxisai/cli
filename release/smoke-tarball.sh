#!/bin/sh
# Checks that one standalone tarball runs on this machine, with no Node.js on PATH:
#
#   sh release/smoke-tarball.sh dist/release/download/v<v>/nxis-<v>-<platform>.tar.gz
#
# It unpacks the tarball into a temporary folder and, under a temporary HOME with a PATH that has
# no node, runs `nxis --version` (which has to match the tarball's version), `nxis --help`,
# `nxis status --json` (signed out: no network needed) and an MCP handshake with `nxis mcp serve`.

set -eu

tarball=${1:?usage: smoke-tarball.sh <nxis-<v>-<platform>.tar.gz>}
name=$(basename "$tarball" .tar.gz)
version=$(printf '%s\n' "$name" | sed -En 's/^nxis-(.+)-(darwin|linux)-(arm64|x64)$/\1/p')
[ -n "$version" ] || { echo "smoke: $tarball isn't named nxis-<version>-<platform>.tar.gz" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
tar -xzf "$tarball" -C "$tmp"
nxis="$tmp/$name/bin/nxis"
mkdir "$tmp/home"
run() { env -i HOME="$tmp/home" PATH=/usr/bin:/bin NXIS_NO_KEYCHAIN=1 NXIS_NO_BROWSER=1 "$nxis" "$@"; }

if env -i PATH=/usr/bin:/bin sh -c 'command -v node' >/dev/null 2>&1; then
  echo "smoke: note: /usr/bin or /bin has a node; the check still runs the bundled one"
fi

got=$(run --version)
[ "$got" = "$version" ] || { echo "smoke: --version says '$got', not $version" >&2; exit 1; }
echo "smoke: --version $got"

run --help | grep -q '^Usage' || { echo "smoke: --help didn't print the usage" >&2; exit 1; }
echo "smoke: --help ok"

run status --json >"$tmp/status.json" || true
grep -q '"signed_in": false' "$tmp/status.json" || { echo "smoke: status --json didn't report signed out:" >&2; cat "$tmp/status.json" >&2; exit 1; }
echo "smoke: status --json ok"

# The MCP server answers initialize and lists its tools, while stdin stays open.
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' >"$tmp/in"
{ cat "$tmp/in"; sleep 3; } | run mcp serve >"$tmp/mcp.out" 2>"$tmp/mcp.err" || true
grep -q "\"version\":\"$version\"" "$tmp/mcp.out" || { echo "smoke: mcp serve didn't answer initialize with $version:" >&2; cat "$tmp/mcp.out" "$tmp/mcp.err" >&2; exit 1; }
grep -q '"tools":\[' "$tmp/mcp.out" || { echo "smoke: mcp serve didn't list its tools" >&2; exit 1; }
echo "smoke: mcp serve ok"
echo "smoke: $name runs"
