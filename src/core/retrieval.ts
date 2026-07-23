import type { Store } from "./store.js";
import type {
  Chunk,
  SearchMode,
  SearchResponse,
  SearchResult,
} from "./types.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";

const CANDIDATES = 20;
const DEFAULT_K = 8;
const RRF_K = 60;

interface ChunkRow {
  rowid: number;
  id: string;
  name: string;
  parent: string | null;
  kind: Chunk["kind"];
  extends: string | null;
  hash_id: string | null;
  sources: string;
  refs: string;
  text: string;
  line_start: number;
  line_end: number;
}

/** Turn a free-text question into a safe FTS5 MATCH expression. */
export function toFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return "";
  // Quote each token (defuses FTS operators) and OR them together.
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function ftsLeg(store: Store, query: string, limit: number): number[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const rows = store.db
    .prepare(
      `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts) LIMIT ?`,
    )
    .all(match, limit) as { rowid: number }[];
  return rows.map((r) => r.rowid);
}

function vecLeg(store: Store, embedding: Float32Array, limit: number): number[] {
  const rows = store.db
    .prepare(
      `SELECT rowid FROM chunks_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(embedding.buffer), limit) as { rowid: number }[];
  return rows.map((r) => r.rowid);
}

/** Reciprocal Rank Fusion over any number of ranked rowid lists. */
export function rrf(lists: number[][], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const rowid = list[rank]!;
      scores.set(rowid, (scores.get(rowid) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}

function fetchRows(store: Store, rowids: number[]): Map<number, ChunkRow> {
  if (rowids.length === 0) return new Map();
  const placeholders = rowids.map(() => "?").join(",");
  const rows = store.db
    .prepare(`SELECT rowid, * FROM chunks WHERE rowid IN (${placeholders})`)
    .all(...rowids) as ChunkRow[];
  return new Map(rows.map((r) => [r.rowid, r]));
}

function snippet(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function toResult(row: ChunkRow, score: number): SearchResult {
  return {
    name: row.name,
    parent: row.parent,
    kind: row.kind,
    hashId: row.hash_id,
    snippet: snippet(row.text),
    sources: JSON.parse(row.sources) as string[],
    score,
  };
}

export interface SearchOptions {
  query: string;
  k?: number;
  mode?: SearchMode;
  provider?: EmbeddingProvider;
}

export async function search(
  store: Store,
  opts: SearchOptions,
): Promise<SearchResponse> {
  const k = opts.k ?? DEFAULT_K;
  const mode = opts.mode ?? "hybrid";
  const wantVectors = mode === "hybrid" || mode === "vector";

  let degradedToKeyword = false;
  let note: string | undefined;

  // Vector leg (best-effort).
  let vecRowids: number[] = [];
  if (wantVectors) {
    const reason = await vectorUnavailableReason(store, opts.provider);
    if (reason) {
      degradedToKeyword = true;
      note = reason;
    } else {
      const [emb] = await opts.provider!.embed([opts.query], "query");
      vecRowids = vecLeg(store, emb!, CANDIDATES);
    }
  }

  // Keyword leg (always run unless pure vector succeeded).
  const runKeyword = mode !== "vector" || degradedToKeyword;
  const ftsRowids = runKeyword ? ftsLeg(store, opts.query, CANDIDATES) : [];

  const lists: number[][] = [];
  if (vecRowids.length) lists.push(vecRowids);
  if (ftsRowids.length) lists.push(ftsRowids);

  const scores = rrf(lists);
  const rowMap = fetchRows(store, [...scores.keys()]);

  // Dedupe by entity name, keeping the best-scoring chunk per name.
  const byName = new Map<string, { row: ChunkRow; score: number }>();
  for (const [rowid, score] of scores) {
    const row = rowMap.get(rowid);
    if (!row) continue;
    const prev = byName.get(row.name);
    if (!prev || score > prev.score) byName.set(row.name, { row, score });
  }

  const results = [...byName.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ row, score }) => toResult(row, score));

  return { results, ...(degradedToKeyword ? { degradedToKeyword, note } : {}) };
}

/** Returns a human reason string when the vector leg cannot run, else null. */
async function vectorUnavailableReason(
  store: Store,
  provider?: EmbeddingProvider,
): Promise<string | null> {
  if (!store.hasVectors() || !store.vecAvailable) {
    return "index has no vectors — reingest with an embedding backend";
  }
  if (!provider) return "no embedding provider configured";
  const model = store.getMetaValue("embed_model");
  const dims = store.getMetaValue("embed_dims");
  if (model && model !== provider.model) {
    return `index embedded with ${model}, query provider is ${provider.model} — reingest`;
  }
  if (dims && Number(dims) !== provider.dims) {
    return `embedding dims mismatch (index ${dims}, provider ${provider.dims}) — reingest`;
  }
  if (!(await provider.available())) {
    return `embedding backend (${provider.model}) unavailable — keyword only`;
  }
  return null;
}

export interface EntityDetail {
  name: string;
  kind: Chunk["kind"];
  parent: string | null;
  extends: string | null;
  hashId: string | null;
  sources: string[];
  refs: string[];
  text: string;
  lineStart: number;
  lineEnd: number;
}

function rowToDetail(row: ChunkRow): EntityDetail {
  return {
    name: row.name,
    kind: row.kind,
    parent: row.parent,
    extends: row.extends,
    hashId: row.hash_id,
    sources: JSON.parse(row.sources) as string[],
    refs: JSON.parse(row.refs) as string[],
    text: row.text,
    lineStart: row.line_start,
    lineEnd: row.line_end,
  };
}

/** Exact lookup: by hash id, then exact name, then FTS name-prefix fallback. */
export function getEntity(
  store: Store,
  nameOrHash: string,
): EntityDetail | null {
  const byHash = store.db
    .prepare("SELECT rowid, * FROM chunks WHERE hash_id = ? LIMIT 1")
    .get(nameOrHash) as ChunkRow | undefined;
  if (byHash) return rowToDetail(byHash);

  // Exact name (case-sensitive), preferring a top-level entity over a promoted child.
  const byName = store.db
    .prepare(
      "SELECT rowid, * FROM chunks WHERE name = ? ORDER BY parent IS NOT NULL LIMIT 1",
    )
    .get(nameOrHash) as ChunkRow | undefined;
  if (byName) return rowToDetail(byName);

  // Case-insensitive exact, then case-insensitive prefix — a tight fallback that
  // tolerates capitalization/partial names without matching on shared words.
  const ci = store.db
    .prepare(
      `SELECT rowid, * FROM chunks WHERE name = ? COLLATE NOCASE
       ORDER BY parent IS NOT NULL LIMIT 1`,
    )
    .get(nameOrHash) as ChunkRow | undefined;
  if (ci) return rowToDetail(ci);

  const prefix = store.db
    .prepare(
      `SELECT rowid, * FROM chunks WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
       ORDER BY LENGTH(name), parent IS NOT NULL LIMIT 1`,
    )
    .get(nameOrHash.replace(/[\\%_]/g, "\\$&") + "%") as ChunkRow | undefined;
  if (prefix) return rowToDetail(prefix);

  return null;
}

export interface RelatedResult {
  extendsParent: string | null;
  extendsChildren: string[];
  references: string[];
  referencedBy: string[];
}

/** Neighbourhood of an entity: inheritance both ways + caret-ref graph both ways. */
export function getRelated(store: Store, name: string): RelatedResult | null {
  const self = store.db
    .prepare("SELECT rowid, * FROM chunks WHERE name = ? LIMIT 1")
    .get(name) as ChunkRow | undefined;
  if (!self) return null;

  const children = (
    store.db
      .prepare("SELECT DISTINCT name FROM chunks WHERE extends = ?")
      .all(name) as { name: string }[]
  ).map((r) => r.name);

  const references = JSON.parse(self.refs) as string[];

  // Incoming refs: scan all chunks' refs JSON for this name (corpora are small).
  const referencedBy = (
    store.db
      .prepare(
        `SELECT DISTINCT name FROM chunks
         WHERE refs LIKE '%' || ? || '%' AND name != ?`,
      )
      .all(JSON.stringify(name).slice(1, -1), name) as { name: string }[]
  )
    .filter((r) => {
      const row = store.db
        .prepare("SELECT refs FROM chunks WHERE name = ? LIMIT 1")
        .get(r.name) as { refs: string } | undefined;
      return row ? (JSON.parse(row.refs) as string[]).includes(name) : false;
    })
    .map((r) => r.name);

  return {
    extendsParent: self.extends,
    extendsChildren: children,
    references,
    referencedBy,
  };
}
