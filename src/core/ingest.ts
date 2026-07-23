import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { chunk, stripComments } from "./chunker.js";
import { loadResolved } from "./resolved.js";
import { Store } from "./store.js";
import type { Chunk } from "./types.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";

export interface IngestOptions {
  corpusId: string;
  mergedPath: string;
  resolvedPath: string;
  dbPath: string;
  provider?: EmbeddingProvider;
  force?: boolean;
  /** progress sink; defaults to no-op */
  log?: (msg: string) => void;
}

export interface IngestResult {
  corpusId: string;
  chunkCount: number;
  entityCount: number;
  embedded: boolean;
  skipped: boolean;
  /** reason embeddings were skipped, when applicable */
  embedNote?: string;
}

/** Contextual header prepended to a chunk's text before embedding. */
export function embeddingInput(c: Chunk): string {
  const bits: string[] = [c.kind];
  if (c.extends) bits.push(`extends ${c.extends}`);
  if (c.parent) bits.push(`part of ${c.parent}`);
  const header = `${c.name} (${bits.join(", ")})`;
  return `${header}\n${stripComments(c.text)}`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function ingestCorpus(opts: IngestOptions): Promise<IngestResult> {
  const log = opts.log ?? (() => {});
  const mergedSha = sha256File(opts.mergedPath);
  const resolvedSha = sha256File(opts.resolvedPath);

  // Staleness check: skip when the DB was built from identical artifacts.
  if (!opts.force && existsSync(opts.dbPath)) {
    try {
      const existing = Store.open(opts.dbPath, { readonly: true });
      const same =
        existing.getMetaValue("merged_sha256") === mergedSha &&
        existing.getMetaValue("resolved_sha256") === resolvedSha;
      const meta = existing.meta();
      existing.close();
      if (same) {
        log(`up to date (${meta.chunkCount} chunks); use --force to rebuild`);
        return {
          corpusId: opts.corpusId,
          chunkCount: meta.chunkCount,
          entityCount: meta.entityCount,
          embedded: meta.vectorReady,
          skipped: true,
        };
      }
    } catch {
      // fall through to rebuild on any read error
    }
  }

  const resolved = loadResolved(opts.resolvedPath);
  const merged = readFileSync(opts.mergedPath, "utf8");
  const chunks = chunk(merged, { corpusId: opts.corpusId, resolved });
  log(`chunked ${chunks.length} units (${resolved.entityCount} entities)`);

  // Optional embeddings.
  let embeddings: Float32Array[] | null = null;
  let embedNote: string | undefined;
  const provider = opts.provider;
  if (provider) {
    if (await provider.available()) {
      log(`embedding ${chunks.length} chunks via ${provider.model}…`);
      embeddings = await provider.embed(
        chunks.map(embeddingInput),
        "document",
      );
    } else {
      embedNote = `embedding backend (${provider.model}) unavailable — indexed keyword-only`;
      log(embedNote);
    }
  }

  // Build to a temp DB, then atomically swap.
  const tmp = `${opts.dbPath}.tmp`;
  for (const suffix of ["", "-shm", "-wal"]) {
    if (existsSync(tmp + suffix)) rmSync(tmp + suffix);
  }
  const store = Store.open(tmp);
  store.createSchema(embeddings ? provider!.dims : null);
  store.insertChunks(chunks, embeddings);
  store.setMeta({
    corpus_id: opts.corpusId,
    edition: resolved.edition,
    spec_version: resolved.specVersion,
    entity_count: String(resolved.entityCount),
    embed_model: embeddings ? provider!.model : "",
    embed_dims: embeddings ? String(provider!.dims) : "",
    built_at: new Date().toISOString(),
    merged_sha256: mergedSha,
    resolved_sha256: resolvedSha,
  });
  store.close();

  for (const suffix of ["", "-shm", "-wal"]) {
    if (existsSync(opts.dbPath + suffix)) rmSync(opts.dbPath + suffix);
  }
  renameSync(tmp, opts.dbPath);

  return {
    corpusId: opts.corpusId,
    chunkCount: chunks.length,
    entityCount: resolved.entityCount,
    embedded: embeddings !== null,
    skipped: false,
    embedNote,
  };
}
