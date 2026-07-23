import { existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Store } from "../core/store.js";
import { search, getEntity, getRelated } from "../core/retrieval.js";
import { loadRegistry } from "../core/registry.js";
import { REGISTRY_PATH, dbPathFor, defaultProvider } from "../core/config.js";
import type { EmbeddingProvider } from "../core/embeddings/provider.js";
import type { SearchMode } from "../core/types.js";

/**
 * Rules-lawyer MCP server: retrieval-only tools over indexed synthesist
 * corpora. The answering logic (verbatim quoting, reflection, citation) lives
 * in the Claude Code skill, not here — this server just surfaces the corpus.
 */
export interface BuildOptions {
  /** Path to corpora.json; defaults to the repo registry. */
  registryPath?: string;
  /** Resolve a corpus id to its DB path; defaults to data/index/<id>.db. */
  dbPathFor?: (corpus: string) => string;
  /** Embedding provider factory for vector/hybrid search; defaults to Ollama. */
  provider?: () => EmbeddingProvider;
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const registryPath = opts.registryPath ?? REGISTRY_PATH;
  const resolveDb = opts.dbPathFor ?? dbPathFor;
  const makeProvider = opts.provider ?? defaultProvider;

  const stores = new Map<string, Store>();
  const openCorpus = (corpus: string): Store | { error: string } => {
    const cached = stores.get(corpus);
    if (cached) return cached;
    const dbPath = resolveDb(corpus);
    if (!existsSync(dbPath)) {
      return {
        error: `corpus "${corpus}" is not indexed. Run: npm run ingest -- --corpus ${corpus} --embed`,
      };
    }
    const store = Store.open(dbPath, { readonly: true });
    stores.set(corpus, store);
    return store;
  };

  const jsonContent = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });
  const errorContent = (message: string) => ({
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  });

  const server = new McpServer({
    name: "titterpig-rules-lawyer",
    version: "0.1.0",
  });

  server.registerTool(
    "list_corpora",
    {
      title: "List rules corpora",
      description:
        "List the indexed TTRPG rules corpora available to query. Each query targets exactly one corpus id.",
      inputSchema: {},
    },
    async () => {
      const entries = loadRegistry(registryPath);
      const out = entries.map((e) => {
        const store = openCorpus(e.id);
        if ("error" in store) return { id: e.id, indexed: false };
        const m = store.meta();
        return {
          id: e.id,
          indexed: true,
          edition: m.edition,
          specVersion: m.specVersion,
          entityCount: m.entityCount,
          chunkCount: m.chunkCount,
          vectorReady: m.vectorReady,
          builtAt: m.builtAt,
        };
      });
      return jsonContent({ corpora: out });
    },
  );

  server.registerTool(
    "search_rules",
    {
      title: "Search rules",
      description:
        "Hybrid keyword+semantic search over one corpus. Returns ranked entity/rule chunks with names, sources, and snippets. Use several phrasings; then call get_entity for full verbatim text before answering.",
      inputSchema: {
        corpus: z.string().describe("Corpus id from list_corpora"),
        query: z
          .string()
          .describe("Natural-language ruling question or keywords"),
        k: z.number().int().min(1).max(25).default(8).describe("Max results"),
        mode: z
          .enum(["hybrid", "keyword", "vector"])
          .default("hybrid")
          .describe("Retrieval mode; hybrid is recommended"),
      },
    },
    async ({ corpus, query, k, mode }) => {
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      const res = await search(store, {
        query,
        k,
        mode: mode as SearchMode,
        provider: mode === "keyword" ? undefined : makeProvider(),
      });
      return jsonContent(res);
    },
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description:
        "Fetch one entity's full VERBATIM text plus metadata (kind, extends, hash, sources, outgoing refs) by exact name or #hash. Always read this before quoting a rule — snippets are truncated.",
      inputSchema: {
        corpus: z.string().describe("Corpus id from list_corpora"),
        name_or_hash: z
          .string()
          .describe('Exact entity name (e.g. "Vulnerable") or #hash anchor'),
      },
    },
    async ({ corpus, name_or_hash }) => {
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      const entity = getEntity(store, name_or_hash);
      if (!entity)
        return errorContent(`no entity matching "${name_or_hash}" in ${corpus}`);
      return jsonContent(entity);
    },
  );

  server.registerTool(
    "get_related",
    {
      title: "Get related entities",
      description:
        "Neighbourhood of an entity: its EXTENDS parent and children, plus the caret-reference graph both directions. Use to follow a rule to the concepts it depends on before answering.",
      inputSchema: {
        corpus: z.string().describe("Corpus id from list_corpora"),
        name: z.string().describe("Exact entity name"),
      },
    },
    async ({ corpus, name }) => {
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      const related = getRelated(store, name);
      if (!related) return errorContent(`no entity named "${name}" in ${corpus}`);
      return jsonContent(related);
    },
  );

  return server;
}
