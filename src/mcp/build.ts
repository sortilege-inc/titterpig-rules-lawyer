import { existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Store } from "../core/store.js";
import { search, getEntity, getRelated } from "../core/retrieval.js";
import { loadRegistry } from "../core/registry.js";
import { REGISTRY_PATH, dbPathFor, defaultProvider } from "../core/config.js";
import {
  ACTIVE_CORPUS_PATH,
  getActiveCorpus,
  setActiveCorpus,
} from "../core/session.js";
import type { EmbeddingProvider } from "../core/embeddings/provider.js";
import type { SearchMode } from "../core/types.js";

/**
 * Rules-lawyer MCP server: retrieval-only tools over indexed synthesist
 * corpora. The answering logic (verbatim quoting, reflection, citation) lives
 * in the Claude Code skill, not here — this server just surfaces the corpus.
 *
 * Exactly one corpus is "in scope" at a time (see core/session.ts). The query
 * tools take no corpus argument; they read the active selection, so the model
 * cannot reach outside the corpus the user has chosen.
 */
export interface BuildOptions {
  /** Path to corpora.json; defaults to the repo registry. */
  registryPath?: string;
  /** Resolve a corpus id to its DB path; defaults to data/index/<id>.db. */
  dbPathFor?: (corpus: string) => string;
  /** Embedding provider factory for vector/hybrid search; defaults to Ollama. */
  provider?: () => EmbeddingProvider;
  /** Active-corpus state file; defaults to data/active-corpus.json. */
  statePath?: string;
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const registryPath = opts.registryPath ?? REGISTRY_PATH;
  const resolveDb = opts.dbPathFor ?? dbPathFor;
  const makeProvider = opts.provider ?? defaultProvider;
  const statePath = opts.statePath ?? ACTIVE_CORPUS_PATH;

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

  /** Resolve the in-scope corpus, or an error telling the model to select one. */
  const requireActive = (): string | { error: string } => {
    const { corpus } = getActiveCorpus(statePath);
    if (!corpus) {
      return {
        error:
          "No corpus is in scope. Call list_corpora, then select_corpus to choose exactly one before searching.",
      };
    }
    return corpus;
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

  const corpusSummary = (id: string) => {
    const store = openCorpus(id);
    if ("error" in store) return { id, indexed: false };
    const m = store.meta();
    return {
      id,
      indexed: true,
      edition: m.edition,
      specVersion: m.specVersion,
      entityCount: m.entityCount,
      chunkCount: m.chunkCount,
      vectorReady: m.vectorReady,
      builtAt: m.builtAt,
    };
  };

  server.registerTool(
    "list_corpora",
    {
      title: "List rules corpora",
      description:
        "List the indexed TTRPG rules corpora. Marks which one is currently in scope (active). Use this, then select_corpus, to choose the single corpus all questions run against.",
      inputSchema: {},
    },
    async () => {
      const { corpus: active, pinned } = getActiveCorpus(statePath);
      const entries = loadRegistry(registryPath);
      const corpora = entries.map((e) => ({
        ...corpusSummary(e.id),
        active: e.id === active,
      }));
      return jsonContent({ corpora, active, pinned });
    },
  );

  server.registerTool(
    "active_corpus",
    {
      title: "Active corpus",
      description:
        "Report which corpus is currently in scope (the working set all queries run against), or null if none is selected yet.",
      inputSchema: {},
    },
    async () => {
      const { corpus, pinned } = getActiveCorpus(statePath);
      if (!corpus) return jsonContent({ active: null, pinned: false });
      return jsonContent({ active: corpus, pinned, ...corpusSummary(corpus) });
    },
  );

  server.registerTool(
    "select_corpus",
    {
      title: "Select corpus",
      description:
        "Put one corpus in scope for all subsequent questions (like `cd` into a rulebook). Persists until changed. All later search_rules / get_entity / get_related run against this corpus only.",
      inputSchema: {
        corpus: z.string().describe("Corpus id from list_corpora"),
      },
    },
    async ({ corpus }) => {
      const current = getActiveCorpus(statePath);
      if (current.pinned) {
        return errorContent(
          `Session is pinned to "${current.corpus}" via RULES_LAWYER_CORPUS and cannot be switched here. Restart without that env var (or with a different value) to change scope.`,
        );
      }
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      setActiveCorpus(corpus, statePath);
      return jsonContent({
        active: corpus,
        pinned: false,
        ...corpusSummary(corpus),
      });
    },
  );

  server.registerTool(
    "search_rules",
    {
      title: "Search rules",
      description:
        "Hybrid keyword+semantic search over the IN-SCOPE corpus (set via select_corpus). Returns ranked entity/rule chunks with names, sources, and snippets. Use several phrasings; then call get_entity for full verbatim text before answering.",
      inputSchema: {
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
    async ({ query, k, mode }) => {
      const corpus = requireActive();
      if (typeof corpus !== "string") return errorContent(corpus.error);
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      const res = await search(store, {
        query,
        k,
        mode: mode as SearchMode,
        provider: mode === "keyword" ? undefined : makeProvider(),
      });
      return jsonContent({ corpus, ...res });
    },
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description:
        "Fetch one entity's full VERBATIM text plus metadata (kind, extends, hash, sources, outgoing refs) from the IN-SCOPE corpus, by exact name or #hash. Always read this before quoting a rule — snippets are truncated.",
      inputSchema: {
        name_or_hash: z
          .string()
          .describe('Exact entity name (e.g. "Vulnerable") or #hash anchor'),
      },
    },
    async ({ name_or_hash }) => {
      const corpus = requireActive();
      if (typeof corpus !== "string") return errorContent(corpus.error);
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      const entity = getEntity(store, name_or_hash);
      if (!entity)
        return errorContent(`no entity matching "${name_or_hash}" in ${corpus}`);
      return jsonContent({ corpus, ...entity });
    },
  );

  server.registerTool(
    "get_related",
    {
      title: "Get related entities",
      description:
        "Neighbourhood of an entity in the IN-SCOPE corpus: its EXTENDS parent and children, plus the caret-reference graph both directions. Use to follow a rule to the concepts it depends on before answering.",
      inputSchema: {
        name: z.string().describe("Exact entity name"),
      },
    },
    async ({ name }) => {
      const corpus = requireActive();
      if (typeof corpus !== "string") return errorContent(corpus.error);
      const store = openCorpus(corpus);
      if ("error" in store) return errorContent(store.error);
      const related = getRelated(store, name);
      if (!related) return errorContent(`no entity named "${name}" in ${corpus}`);
      return jsonContent({ corpus, ...related });
    },
  );

  return server;
}
