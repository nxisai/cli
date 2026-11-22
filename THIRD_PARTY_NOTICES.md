# Third-party notices

## Runtime dependencies

`@nxisai/cli` depends on two packages at runtime. The provisioning commands talk to NxisAI over
the Model Context Protocol, and these are the protocol's reference TypeScript SDK and the schema
library it is built on. Everything else the CLI does — HTTP, JSON, crypto, the OS keychain
shell-out — still comes from the Node.js standard library.

| Package | Version | License |
|---|---|---|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.32.2 | MIT |
| [zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT |

They install further packages of their own (about 95 in all, `npm ls --omit=dev --all` lists
them). Every one is under a permissive license: MIT for most, ISC, and BSD-2-Clause
(`json-schema-typed`) or BSD-3-Clause (`fast-uri`, `qs`) for the rest. None is copyleft. Each
carries its own license text in its own distribution, which installing the CLI places alongside
it in `node_modules`.

The published package itself contains only this project's own compiled code; the dependencies
are installed from npm, not bundled.

## Build and development dependencies

These are used to compile and test the project. They are **not** included in the published
package and are not present at runtime.

| Package | Version | License |
|---|---|---|
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 |
| [vitest](https://github.com/vitest-dev/vitest) | 2.1.9 | MIT |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 22.20.2 | MIT |
| [esbuild](https://github.com/evanw/esbuild) | 0.28.2 | MIT |

Each carries its own license text in its own distribution. None is copyleft, and none imposes
obligations on users of the published package, since none of them ships in it.

## The standalone build

The standalone tarballs (`release/build.mjs`) are not the npm package. Each one bundles the
runtime dependencies above into one file, and ships with:

- `app/THIRD_PARTY_LICENSES`: every bundled package's name, version, license and license text,
  written by the build from the packages themselves.
- `NODE-LICENSE`: the license of the Node.js runtime in `bin/node`, an unmodified official
  build from nodejs.org.

## Keeping this accurate

If a runtime dependency is added, removed or upgraded to a new major version, this file is
updated in the same change.
