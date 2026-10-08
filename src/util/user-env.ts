/**
 * A user-level `.env` at `~/.symgraph/.env` (or `$SYMGRAPH_HOME/.env`), so one
 * provider key and model serve every repo instead of a copy per project.
 *
 * It only fills what is still unset: the shell environment wins, then the
 * project's own `.env` (loaded by `dotenv/config` before this runs, and already
 * carried from `GRAFT_*` by env-compat), then this file. A project that points
 * `--deep` at a local model keeps doing so.
 *
 * Imported for its side effect by the CLI, right after env-compat.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { applyLegacyEnv } from "./env-compat.js";

export function userEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SYMGRAPH_HOME || join(homedir(), ".symgraph"), ".env");
}

/** Fill unset variables from the user-level `.env`. Returns the names it set. */
export function loadUserEnv(env: NodeJS.ProcessEnv = process.env, path = userEnvPath(env)): string[] {
  let parsed: Record<string, string>;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch {
    return []; // no user-level file — nothing to do
  }
  const filled: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    // A SYMGRAPH_X already reached via a project-level GRAFT_X counts as set.
    if (env[key] !== undefined) continue;
    env[key] = value;
    filled.push(key);
  }
  applyLegacyEnv(env); // a GRAFT_* line in the user file still counts
  return filled;
}

loadUserEnv();
