import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RegistrySchema, type CorpusEntry } from "./types.js";

const MERGED_SUFFIX = ".merged.ttrpg";

/** Recursively collect *.merged.ttrpg files under a root (bounded; skips hidden/node_modules). */
function findMergedFiles(root: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable/missing dir → nothing to discover here
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) walk(p, depth - 1);
      } else if (e.isFile() && e.name.endsWith(MERGED_SUFFIX)) {
        out.push(p);
      }
    }
  };
  walk(root, maxDepth);
  return out.sort();
}

/**
 * Discover corpora under a root: each `<id>.merged.ttrpg` pairs with a sibling
 * `<id>.resolved.json` (required) and an optional `<id>.sources.json` or
 * `sources.json` in the same directory. The id is the merged file's basename.
 */
function discoverCorpora(root: string): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const merged of findMergedFiles(root)) {
    const id = basename(merged, MERGED_SUFFIX);
    const dir = dirname(merged);
    const resolved = join(dir, `${id}.resolved.json`);
    if (!existsSync(resolved)) {
      console.warn(
        `[corpora] ${id}: ${basename(merged)} has no sibling ${id}.resolved.json — skipped`,
      );
      continue;
    }
    const siblingSources = join(dir, `${id}.sources.json`);
    const dirSources = join(dir, "sources.json");
    const sources = existsSync(siblingSources)
      ? siblingSources
      : existsSync(dirSources)
        ? dirSources
        : undefined;
    entries.push({ id, merged, resolved, sources });
  }
  return entries;
}

/**
 * Load the registry: auto-discovered corpora from the root directory
 * (corpora.json `root`, or the TITTERPIG_CORPORA env var), merged with any
 * explicit `corpora` entries. Explicit entries win on id collision. Relative
 * paths resolve against corpora.json's directory.
 */
export function loadRegistry(registryPath: string): CorpusEntry[] {
  const reg = RegistrySchema.parse(
    JSON.parse(readFileSync(registryPath, "utf8")),
  );
  const base = dirname(resolve(registryPath));
  const abs = (p: string) => (p.startsWith("/") ? p : resolve(base, p));

  const byId = new Map<string, CorpusEntry>();

  const rootSetting = process.env.TITTERPIG_CORPORA ?? reg.root;
  if (rootSetting) {
    for (const e of discoverCorpora(abs(rootSetting))) byId.set(e.id, e);
  }

  // Explicit entries override discovery.
  for (const c of reg.corpora) {
    byId.set(c.id, {
      ...c,
      merged: abs(c.merged),
      resolved: abs(c.resolved),
      sources: c.sources ? abs(c.sources) : undefined,
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function findCorpus(
  registryPath: string,
  id: string,
): CorpusEntry | undefined {
  return loadRegistry(registryPath).find((c) => c.id === id);
}
