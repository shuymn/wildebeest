#!/usr/bin/env node
/* global process */
// kopje-admin: operations CLI for a Kopje instance (calls /admin/* through Cloudflare Access).
import { run } from "./lib/main.js";
import { nodeIO } from "./lib/node-io.js";

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  io: nodeIO,
  stdout: process.stdout,
  stderr: process.stderr,
});
