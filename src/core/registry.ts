import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RegistrySchema, type CorpusEntry } from "./types.js";

/** Load and validate corpora.json, resolving relative artifact paths against it. */
export function loadRegistry(registryPath: string): CorpusEntry[] {
  const reg = RegistrySchema.parse(
    JSON.parse(readFileSync(registryPath, "utf8")),
  );
  const base = dirname(resolve(registryPath));
  const abs = (p: string) => (p.startsWith("/") ? p : resolve(base, p));
  return reg.corpora.map((c) => ({
    ...c,
    merged: abs(c.merged),
    resolved: abs(c.resolved),
    sources: c.sources ? abs(c.sources) : undefined,
  }));
}

export function findCorpus(
  registryPath: string,
  id: string,
): CorpusEntry | undefined {
  return loadRegistry(registryPath).find((c) => c.id === id);
}
