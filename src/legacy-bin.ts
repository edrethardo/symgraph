#!/usr/bin/env node
/**
 * The `graft` bin. The fork was renamed to symgraph; this keeps scripts, MCP
 * configs and muscle memory that still say `graft …` working, with one line on
 * stderr (never stdout — `graft mcp` speaks JSON-RPC there) pointing at the new
 * name. Everything after that is the real CLI.
 */
const args = process.argv.slice(2).join(" ");
process.stderr.write(`graft is now symgraph — use \`symgraph${args ? ` ${args}` : ""}\`\n`);
await import("./cli.js");
