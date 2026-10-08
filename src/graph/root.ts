/**
 * Where "here" is when a query names no directory. An agent session — or a plain
 * shell — started in a subdirectory of an indexed repo should still find the
 * graph, so the implicit root is the nearest ANCESTOR holding a symgraph index:
 * either a repo's own wiring graph (`symgraph/.graph/wiring.json`) or a workspace
 * parent's children index (`symgraph/workspace.json`). Nothing indexed anywhere
 * above → the start dir itself, so `symgraph build` in a fresh repo still means
 * "here" and no command silently retargets a sibling tree.
 *
 * Only the IMPLICIT case walks. An explicit `[dir]` argument is taken at face
 * value, and a `--dir` override short-circuits entirely: `contextDirFor` returns
 * an override verbatim and ignores the root it is handed, so every ancestor
 * would report the same context dir and the walk would answer "level 0" for a
 * dir that isn't the repo.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { wiringPath } from "./write.js";
import { workspacePath } from "./workspace.js";

/** True when `dir` is a symgraph root of either shape — a built repo or a workspace parent. */
export function hasSymgraphIndex(dir: string): boolean {
  return existsSync(wiringPath(contextDirFor(dir))) || existsSync(workspacePath(dir));
}

export interface RootResolution {
  /** Absolute dir to run the command against. */
  root: string;
  /** Directory levels walked up; 0 when the start dir was already the root (the common case). */
  levels: number;
}

/** The nearest ancestor of `start` (inclusive) that holds a symgraph index, else `start`. */
export function nearestSymgraphRoot(start: string, override?: string): RootResolution {
  const from = resolve(start);
  if (override) return { root: from, levels: 0 };
  let dir = from;
  for (let levels = 0; ; levels++) {
    if (hasSymgraphIndex(dir)) return { root: dir, levels };
    const up = dirname(dir);
    if (up === dir) return { root: from, levels: 0 }; // hit the filesystem root, nothing indexed
    dir = up;
  }
}
