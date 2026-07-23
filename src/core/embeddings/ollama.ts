import type { EmbeddingProvider, EmbedRole } from "./provider.js";

/**
 * Local embeddings via an Ollama server (`/api/embed`). Default model
 * nomic-embed-text (768-dim), which wants asymmetric task prefixes:
 * `search_document:` at ingest, `search_query:` at retrieval.
 *
 * No hard dependency: if the server is down or the model is not pulled,
 * `available()` returns false and the caller degrades to keyword-only.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(opts: {
    baseUrl?: string;
    model?: string;
    dims?: number;
    batchSize?: number;
  } = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model ?? "nomic-embed-text";
    this.dims = opts.dims ?? 768;
    this.batchSize = opts.batchSize ?? 96;
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: { name?: string }[] };
      const names = (body.models ?? []).map((m) => m.name ?? "");
      // Match with or without an explicit :tag (e.g. "nomic-embed-text:latest").
      return names.some(
        (n) => n === this.model || n.startsWith(`${this.model}:`),
      );
    } catch {
      return false;
    }
  }

  private prefix(role: EmbedRole): string {
    if (this.model.startsWith("nomic-embed-text")) {
      return role === "query" ? "search_query: " : "search_document: ";
    }
    return "";
  }

  async embed(texts: string[], role: EmbedRole): Promise<Float32Array[]> {
    const prefix = this.prefix(role);
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => prefix + t);
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!res.ok) {
        throw new Error(
          `Ollama /api/embed failed: ${res.status} ${await res.text()}`,
        );
      }
      const body = (await res.json()) as { embeddings?: number[][] };
      if (!body.embeddings || body.embeddings.length !== batch.length) {
        throw new Error("Ollama /api/embed returned an unexpected shape");
      }
      for (const vec of body.embeddings) {
        if (vec.length !== this.dims) {
          throw new Error(
            `embedding dims mismatch: expected ${this.dims}, got ${vec.length}`,
          );
        }
        out.push(Float32Array.from(vec));
      }
    }
    return out;
  }
}
