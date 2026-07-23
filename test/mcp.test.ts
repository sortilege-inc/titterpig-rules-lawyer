import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ingestCorpus } from "../src/core/ingest.js";
import { FakeEmbeddingProvider } from "../src/core/embeddings/provider.js";
import { buildServer } from "../src/mcp/build.js";

const FIX = resolve(__dirname, "fixtures");
const CORPUS = "daggerheart-0.4";

function parseToolJson(result: unknown): any {
  const r = result as { content: { type: string; text: string }[] };
  return JSON.parse(r.content[0]!.text);
}

describe("MCP server (in-memory transport)", () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "trl-mcp-"));
    const dbPath = resolve(dir, `${CORPUS}.db`);
    await ingestCorpus({
      corpusId: CORPUS,
      mergedPath: resolve(FIX, `${CORPUS}.merged.ttrpg`),
      resolvedPath: resolve(FIX, `${CORPUS}.resolved.json`),
      dbPath,
      provider: new FakeEmbeddingProvider(64),
    });
    const registryPath = resolve(dir, "corpora.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        corpora: [
          {
            id: CORPUS,
            merged: resolve(FIX, `${CORPUS}.merged.ttrpg`),
            resolved: resolve(FIX, `${CORPUS}.resolved.json`),
          },
        ],
      }),
    );

    const server = buildServer({
      registryPath,
      dbPathFor: (id) => resolve(dir, `${id}.db`),
      provider: () => new FakeEmbeddingProvider(64),
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("advertises the four tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_entity",
      "get_related",
      "list_corpora",
      "search_rules",
    ]);
  });

  it("list_corpora reports the indexed corpus", async () => {
    const res = await client.callTool({ name: "list_corpora", arguments: {} });
    const data = parseToolJson(res);
    expect(data.corpora[0].id).toBe(CORPUS);
    expect(data.corpora[0].indexed).toBe(true);
    expect(data.corpora[0].entityCount).toBe(803);
  });

  it("search_rules (hybrid) finds the Condition entity for 'Vulnerable'", async () => {
    const res = await client.callTool({
      name: "search_rules",
      arguments: { corpus: CORPUS, query: "Vulnerable condition", mode: "hybrid", k: 8 },
    });
    const data = parseToolJson(res);
    expect(data.results.map((r: any) => r.name)).toContain("Condition");
  });

  it("get_entity returns full verbatim text by name", async () => {
    const res = await client.callTool({
      name: "get_entity",
      arguments: { corpus: CORPUS, name_or_hash: "Condition" },
    });
    const data = parseToolJson(res);
    expect(data.text).toContain("Vulnerable");
    expect(data.sources).toContain("daggerheart-0.4-core-base.ttrpg");
  });

  it("get_entity reports a clear error for an unknown name", async () => {
    const res = (await client.callTool({
      name: "get_entity",
      arguments: { corpus: CORPUS, name_or_hash: "No Such Thing Xyzzy" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("get_related resolves a known entity", async () => {
    const res = await client.callTool({
      name: "get_related",
      arguments: { corpus: CORPUS, name: "Condition" },
    });
    const data = parseToolJson(res);
    expect(Array.isArray(data.extendsChildren)).toBe(true);
    expect(Array.isArray(data.references)).toBe(true);
  });
});
