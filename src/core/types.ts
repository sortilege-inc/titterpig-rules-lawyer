import { z } from "zod";

/** A retrievable unit extracted from a merged.ttrpg corpus. */
export interface Chunk {
  /** sha256(corpus | qualifiedName | text) */
  id: string;
  /** Entity display name or generic-block name. */
  name: string;
  /** Enclosing top-level GenericBlock, when this chunk is a promoted nested DEF. */
  parent: string | null;
  kind: "def" | "actor" | "template" | "block";
  /** EXTENDS target (from resolved.json), when present. */
  extends: string | null;
  /** Stable #hash anchor, when the source DEF carried one. */
  hashId: string | null;
  /** Source .ttrpg filenames (from resolved.json provenance). */
  sources: string[];
  /** Outgoing caret refs (^"Other") found in this chunk's text. */
  refs: string[];
  /** Verbatim slice of the merged.ttrpg — the citation/quote source. */
  text: string;
  lineStart: number;
  lineEnd: number;
}

/** Registry entry: corpus id → synthesist artifact paths. */
export const CorpusEntrySchema = z.object({
  id: z.string().min(1),
  merged: z.string().min(1),
  resolved: z.string().min(1),
  sources: z.string().optional(),
});
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

export const RegistrySchema = z.object({
  /**
   * Directory to auto-discover corpora in: every `<id>.merged.ttrpg` under it
   * (paired with a sibling `<id>.resolved.json`) becomes a corpus. Relative to
   * corpora.json; overridden by the TITTERPIG_CORPORA env var.
   */
  root: z.string().optional(),
  /** Explicit entries; supplement discovery and win on id collision. */
  corpora: z.array(CorpusEntrySchema).default([]),
});
export type Registry = z.infer<typeof RegistrySchema>;

/** Per-corpus metadata persisted in the DB `meta` table and reported by list_corpora. */
export interface CorpusMeta {
  corpusId: string;
  edition: string;
  specVersion: string;
  entityCount: number;
  chunkCount: number;
  embedModel: string | null;
  embedDims: number | null;
  builtAt: string;
  vectorReady: boolean;
}

export type SearchMode = "hybrid" | "keyword" | "vector";

export interface SearchResult {
  name: string;
  parent: string | null;
  kind: Chunk["kind"];
  hashId: string | null;
  snippet: string;
  sources: string[];
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Set when a hybrid/vector request fell back to keyword-only retrieval. */
  degradedToKeyword?: boolean;
  /** Why it degraded, for CLI/debug visibility. */
  note?: string;
}
