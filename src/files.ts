/**
 * Writing files that hold secrets.
 *
 * @remarks
 * `writeFileSync`'s `mode` applies only when it creates a file, and `mkdirSync`'s only when it
 * creates a directory. A file that already existed — a `0644` `~/.cursor/mcp.json` is the common
 * case — kept its permissions after a key or tokens were written into it. So the mode is set
 * after every write, not just requested at creation.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a file readable by its owner only.
 *
 * @param path - The file.
 * @param content - What to write.
 * @param opts - `privateDir` also makes the containing directory `0700`; only for a directory the
 * CLI owns, never a project or an agent's.
 */
export function writePrivateFile(path: string, content: string, opts: { privateDir?: boolean } = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (opts.privateDir) chmodSync(dir, 0o700);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
