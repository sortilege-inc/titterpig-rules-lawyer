import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadRegistry } from "../src/core/registry.js";

/** Lay down a root/<edition>/<version>/<id>.{merged.ttrpg,resolved.json[,...]} tree. */
function writeCorpus(
  root: string,
  edition: string,
  version: string,
  id: string,
  opts: { resolved?: boolean; sources?: "sibling" | "dir" } = {},
) {
  const dir = join(root, edition, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.merged.ttrpg`), `BASE "${edition}" {}\n`);
  if (opts.resolved !== false)
    writeFileSync(join(dir, `${id}.resolved.json`), "{}");
  if (opts.sources === "sibling")
    writeFileSync(join(dir, `${id}.sources.json`), "{}");
  if (opts.sources === "dir") writeFileSync(join(dir, "sources.json"), "{}");
}

describe("registry discovery", () => {
  let dir: string;
  const registryPath = () => join(dir, "corpora.json");
  const writeRegistry = (obj: unknown) =>
    writeFileSync(registryPath(), JSON.stringify(obj));

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "trl-reg-"));
    delete process.env.TITTERPIG_CORPORA;
  });
  afterEach(() => {
    delete process.env.TITTERPIG_CORPORA;
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovers corpora under a root by their .merged.ttrpg files", () => {
    const root = join(dir, "corpora");
    writeCorpus(root, "tor2e", "0.4", "tor2e-0.4");
    writeCorpus(root, "daggerheart", "0.4", "daggerheart-0.4");
    writeRegistry({ root: "corpora" });

    const reg = loadRegistry(registryPath());
    expect(reg.map((c) => c.id)).toEqual(["daggerheart-0.4", "tor2e-0.4"]);
    const tor = reg.find((c) => c.id === "tor2e-0.4")!;
    expect(tor.merged).toBe(join(root, "tor2e", "0.4", "tor2e-0.4.merged.ttrpg"));
    expect(tor.resolved).toBe(
      join(root, "tor2e", "0.4", "tor2e-0.4.resolved.json"),
    );
  });

  it("picks up sibling and dir-level sources.json", () => {
    const root = join(dir, "corpora");
    writeCorpus(root, "tor2e", "0.4", "tor2e-0.4", { sources: "sibling" });
    writeCorpus(root, "vtm5e", "0.4", "vtm5e-0.4-war", { sources: "dir" });
    writeRegistry({ root: "corpora" });

    const reg = loadRegistry(registryPath());
    expect(reg.find((c) => c.id === "tor2e-0.4")!.sources).toContain(
      "tor2e-0.4.sources.json",
    );
    expect(reg.find((c) => c.id === "vtm5e-0.4-war")!.sources).toContain(
      "sources.json",
    );
  });

  it("skips a merged file with no sibling resolved.json", () => {
    const root = join(dir, "corpora");
    writeCorpus(root, "broken", "0.4", "broken-0.4", { resolved: false });
    writeRegistry({ root: "corpora" });
    expect(loadRegistry(registryPath())).toEqual([]);
  });

  it("TITTERPIG_CORPORA env overrides the file root", () => {
    const envRoot = join(dir, "env-corpora");
    writeCorpus(envRoot, "root", "0.4", "root-0.4");
    writeRegistry({ root: join(dir, "does-not-exist") });

    process.env.TITTERPIG_CORPORA = envRoot;
    expect(loadRegistry(registryPath()).map((c) => c.id)).toEqual(["root-0.4"]);
  });

  it("explicit entries win over discovery on id collision", () => {
    const root = join(dir, "corpora");
    writeCorpus(root, "tor2e", "0.4", "tor2e-0.4");
    const overrideMerged = join(dir, "override.merged.ttrpg");
    const overrideResolved = join(dir, "override.resolved.json");
    writeFileSync(overrideMerged, "BASE {}");
    writeFileSync(overrideResolved, "{}");
    writeRegistry({
      root: "corpora",
      corpora: [
        { id: "tor2e-0.4", merged: overrideMerged, resolved: overrideResolved },
      ],
    });

    const tor = loadRegistry(registryPath()).find((c) => c.id === "tor2e-0.4")!;
    expect(tor.merged).toBe(overrideMerged);
  });

  it("works with no root (explicit entries only)", () => {
    const m = join(dir, "x.merged.ttrpg");
    const r = join(dir, "x.resolved.json");
    writeFileSync(m, "BASE {}");
    writeFileSync(r, "{}");
    writeRegistry({ corpora: [{ id: "x-0.4", merged: m, resolved: r }] });
    expect(loadRegistry(registryPath()).map((c) => c.id)).toEqual(["x-0.4"]);
  });
});
