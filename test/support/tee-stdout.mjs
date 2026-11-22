/**
 * Runs a node script with its stdout copied to a file, byte for byte.
 *
 * Usage: node tee-stdout.mjs <file> <script> [args...]
 *
 * The MCP client's stdio transport parses the server's stdout as it reads it, so a test that
 * wants to check every byte the server wrote puts this between the two.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const [, , file, ...command] = process.argv;
const copy = createWriteStream(file);
const child = spawn(process.execPath, command, { stdio: ["pipe", "pipe", "inherit"] });

process.stdin.pipe(child.stdin);
child.stdout.on("data", (chunk) => {
  copy.write(chunk);
  process.stdout.write(chunk);
});
child.on("close", (code) => {
  copy.end(() => process.exit(code ?? 1));
});
