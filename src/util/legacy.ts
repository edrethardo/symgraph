/**
 * What is left of the old name. The fork was renamed from graft to symgraph;
 * a repo indexed or wired by graft still has `graft/`, `.graft/`, ignore entries
 * naming them, and agent wiring under the graft name. This module moves the
 * on-disk layout across; `hosts/retract.ts` removes the old wiring.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_NAME = "graft";
export const NAME = "symgraph";

/** `graft/` is only ours if it holds what a build writes there; a source folder
 * that happens to be called `graft` must never be moved. */
function isLegacyGraphDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, ".graph")) || existsSync(join(dir, ".cache"));
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Rewrite one ignore file's graft entries (and graft's comment lines) to the new
 * name, leaving every other line as it was. Returns whether it changed. */
function renameIgnoreEntries(path: string): boolean {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  const out = text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("#") && /\bgraft's\b/.test(t)) {
        return line.replace(/\bgraft's\b/g, `${NAME}'s`).replace(/`graft build`/g, `\`${NAME} build\``);
      }
      // `/graft/`, `graft/`, `graft`, `!graft/`, `graft/.cache/`, `/.graft/` …
      const m = /^(!?\/?)(\.?)graft(\/.*)?$/.exec(t);
      return m ? line.replace(t, `${m[1]}${m[2]}${NAME}${m[3] ?? ""}`) : line;
    })
    .join("\n");
  if (out === text) return false;
  try { writeFileSync(path, out); } catch { return false; }
  return true;
}

const migrated = new Set<string>();

/**
 * Move a graft-era layout in `root` to the symgraph names: `graft/` → `symgraph/`,
 * `.graft/` → `.symgraph/`, and the matching `.gitignore` / `.ignore` entries.
 * Only when the new path does not exist yet, so it runs at most once per repo and
 * never merges or overwrites. Best-effort: a failure leaves the old layout in
 * place and the next build simply starts a fresh `symgraph/`.
 *
 * Called from the default-dir resolvers, so every entry point (build, the
 * refresh before a query, the hooks, the MCP server) migrates on first touch.
 * The notice goes to stderr: stdout is the MCP protocol channel.
 */
export function migrateLegacyLayout(root: string): void {
  if (migrated.has(root)) return;
  migrated.add(root);
  const moved: string[] = [];
  const pairs: [string, string, (p: string) => boolean][] = [
    [LEGACY_NAME, NAME, isLegacyGraphDir],
    [`.${LEGACY_NAME}`, `.${NAME}`, isDir],
  ];
  for (const [from, to, isOurs] of pairs) {
    const src = join(root, from);
    const dst = join(root, to);
    if (!isOurs(src) || existsSync(dst)) continue;
    try {
      renameSync(src, dst);
      moved.push(`${from}/ → ${to}/`);
    } catch {
      /* a concurrent process won the race, or the fs refused — nothing to undo */
    }
  }
  if (moved.length === 0) return;
  renameIgnoreEntries(join(root, ".gitignore"));
  renameIgnoreEntries(join(root, ".ignore"));
  process.stderr.write(`symgraph: graft was renamed to symgraph — moved ${moved.join(", ")}\n`);
}
