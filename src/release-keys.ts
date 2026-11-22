/**
 * The public keys that sign standalone releases.
 *
 * @remarks
 * Each is an Ed25519 public key, as base64 of its SPKI DER (what `release/keygen.mjs` prints).
 * `nxis update` and the installer (`release/build.mjs` writes these into it) accept a release
 * whose `manifest.json` is signed by any key here, and nothing else.
 *
 * To rotate: add the new key here and ship a release signed with the old one, so every install
 * learns the new key; sign the releases after it with the new key; remove the old key in a later
 * release.
 *
 * The placeholder is never trusted. `release/sign.mjs` refuses to sign a release for publishing
 * while it is the only key, and `nxis update` ignores it.
 */
export const RELEASE_KEY_PLACEHOLDER = "PLACEHOLDER-make-a-key-with-release-keygen-and-paste-its-public-key-here";

export const RELEASE_KEYS: readonly string[] = [
  // release-2026, made 2026-11-11.
  "MCowBQYDK2VwAyEAm/iQrAGXPqkGbNFBIYekgg4/bYL9SLik4q6eLI6K3YQ=",
];
