import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ingestCorpus } from "../src/core/ingest.js";
import { Store } from "../src/core/store.js";
import { search, getEntity, getRelated, toFtsQuery, rrf } from "../src/core/retrieval.js";
import { FakeEmbeddingProvider } from "../src/core/embeddings/provider.js";

const FIX = resolve(__dirname, "fixtures");

describe("ingest → store → retrieval (daggerheart, fake embeddings)", () => {
  let dir: string;
  let dbPath: string;
  let store: Store;

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "trl-"));
    dbPath = resolve(dir, "daggerheart-0.4.db");
    await ingestCorpus({
      corpusId: "daggerheart-0.4",
      mergedPath: resolve(FIX, "daggerheart-0.4.merged.ttrpg"),
      resolvedPath: resolve(FIX, "daggerheart-0.4.resolved.json"),
      dbPath,
      provider: new FakeEmbeddingProvider(64),
    });
    store = Store.open(dbPath, { readonly: true });
  });

  afterAll(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records meta and chunk count", () => {
    const m = store.meta();
    expect(m.edition).toBe("daggerheart");
    expect(m.entityCount).toBe(803);
    expect(m.chunkCount).toBe(803);
    expect(m.builtAt).not.toBe("");
  });

  it("M1 acceptance: keyword search for 'Vulnerable' finds the Condition entity", async () => {
    const res = await search(store, {
      query: "Vulnerable",
      mode: "keyword",
      k: 8,
    });
    const names = res.results.map((r) => r.name);
    expect(names).toContain("Condition");
  });

  it("hybrid search runs with the fake provider (vectors present)", async () => {
    const res = await search(store, {
      query: "mark stress when out of hope",
      mode: "hybrid",
      k: 8,
      provider: new FakeEmbeddingProvider(64),
    });
    expect(res.degradedToKeyword).toBeUndefined();
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("degrades to keyword when provider dims mismatch the index", async () => {
    const res = await search(store, {
      query: "hope",
      mode: "hybrid",
      k: 5,
      provider: new FakeEmbeddingProvider(128), // index built with 64
    });
    expect(res.degradedToKeyword).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("get_entity resolves by exact name", () => {
    const e = getEntity(store, "Condition");
    expect(e).not.toBeNull();
    expect(e!.text).toContain("Vulnerable");
    expect(e!.kind).toBe("def");
  });

  it("get_related returns inheritance + reference neighbours", () => {
    const r = getRelated(store, "Character");
    expect(r).not.toBeNull();
    // Character is an ACTOR entity; it should at least resolve without error
    expect(Array.isArray(r!.extendsChildren)).toBe(true);
    expect(Array.isArray(r!.references)).toBe(true);
  });
});

describe("staleness skip", () => {
  it("skips reingest when artifacts are unchanged", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "trl-skip-"));
    const dbPath = resolve(dir, "tor2e-0.4.db");
    const opts = {
      corpusId: "tor2e-0.4",
      mergedPath: resolve(FIX, "tor2e-0.4.merged.ttrpg"),
      resolvedPath: resolve(FIX, "tor2e-0.4.resolved.json"),
      dbPath,
    };
    const first = await ingestCorpus(opts);
    expect(first.skipped).toBe(false);
    const second = await ingestCorpus(opts);
    expect(second.skipped).toBe(true);
    const forced = await ingestCorpus({ ...opts, force: true });
    expect(forced.skipped).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("retrieval unit helpers", () => {
  it("toFtsQuery sanitizes operators into OR'd quoted tokens", () => {
    expect(toFtsQuery('what happens - "Endurance" AND Load?')).toBe(
      '"what" OR "happens" OR "endurance" OR "and" OR "load"',
    );
    expect(toFtsQuery("!!!")).toBe("");
  });

  it("rrf fuses ranked lists", () => {
    const fused = rrf([
      [10, 20, 30],
      [20, 40],
    ]);
    // 20 appears in both lists → highest fused score
    const top = [...fused.entries()].sort((a, b) => b[1] - a[1])[0]!;
    expect(top[0]).toBe(20);
  });
});
