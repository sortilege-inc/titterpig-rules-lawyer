import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, CorpusMeta } from "./types.js";

export interface OpenOptions {
  readonly?: boolean;
}

/** Best-effort load of the sqlite-vec extension; returns false if unavailable. */
export function loadVec(db: DB): boolean {
  try {
    sqliteVec.load(db);
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export class Store {
  readonly db: DB;
  readonly vecAvailable: boolean;

  constructor(path: string, opts: OpenOptions = {}) {
    this.db = new Database(path, { readonly: opts.readonly ?? false });
    this.db.pragma("journal_mode = WAL");
    this.vecAvailable = loadVec(this.db);
  }

  static open(path: string, opts: OpenOptions = {}): Store {
    return new Store(path, opts);
  }

  close(): void {
    this.db.close();
  }

  /** Create the full schema. `vecDims` null → skip the vector table (keyword-only). */
  createSchema(vecDims: number | null): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS chunks(
        rowid    INTEGER PRIMARY KEY,
        id       TEXT UNIQUE NOT NULL,
        name     TEXT NOT NULL,
        parent   TEXT,
        kind     TEXT NOT NULL,
        extends  TEXT,
        hash_id  TEXT,
        sources  TEXT NOT NULL,
        refs     TEXT NOT NULL,
        text     TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
      CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        name, text,
        content='chunks', content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    if (vecDims !== null) {
      if (!this.vecAvailable) {
        throw new Error(
          "sqlite-vec extension not available; cannot create vector table",
        );
      }
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${vecDims}]);`,
      );
    }
  }

  setMeta(entries: Record<string, string>): void {
    const stmt = this.db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.db.transaction((rows: [string, string][]) => {
      for (const [k, v] of rows) stmt.run(k, v);
    });
    tx(Object.entries(entries));
  }

  getMetaValue(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Insert chunks and populate FTS (and vectors, when provided and available).
   * `embeddings[i]` corresponds to `chunks[i]`; pass null to skip vectors.
   */
  insertChunks(chunks: Chunk[], embeddings: Float32Array[] | null): void {
    const insert = this.db.prepare(
      `INSERT INTO chunks(id, name, parent, kind, extends, hash_id, sources, refs, text, line_start, line_end)
       VALUES(@id, @name, @parent, @kind, @extends, @hashId, @sources, @refs, @text, @lineStart, @lineEnd)`,
    );
    const insertFts = this.db.prepare(
      "INSERT INTO chunks_fts(rowid, name, text) VALUES(?, ?, ?)",
    );
    const insertVec = embeddings
      ? this.db.prepare(
          "INSERT INTO chunks_vec(rowid, embedding) VALUES(?, ?)",
        )
      : null;

    const tx = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const info = insert.run({
          id: c.id,
          name: c.name,
          parent: c.parent,
          kind: c.kind,
          extends: c.extends,
          hashId: c.hashId,
          sources: JSON.stringify(c.sources),
          refs: JSON.stringify(c.refs),
          text: c.text,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
        });
        const rowid = Number(info.lastInsertRowid);
        insertFts.run(rowid, c.name, c.text);
        if (insertVec) {
          insertVec.run(BigInt(rowid), Buffer.from(embeddings![i]!.buffer));
        }
      }
    });
    tx();
  }

  chunkCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
      n: number;
    };
    return row.n;
  }

  hasVectors(): boolean {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
      )
      .get();
    return !!row;
  }

  meta(): CorpusMeta {
    const g = (k: string) => this.getMetaValue(k);
    const dims = g("embed_dims");
    return {
      corpusId: g("corpus_id") ?? "",
      edition: g("edition") ?? "",
      specVersion: g("spec_version") ?? "",
      entityCount: Number(g("entity_count") ?? "0"),
      chunkCount: this.chunkCount(),
      embedModel: g("embed_model"),
      embedDims: dims ? Number(dims) : null,
      builtAt: g("built_at") ?? "",
      vectorReady: this.hasVectors() && this.vecAvailable,
    };
  }
}
