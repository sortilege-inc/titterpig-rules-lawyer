import { createHash } from "node:crypto";

/** The "role" of a text being embedded; some models want an asymmetric prefix. */
export type EmbedRole = "document" | "query";

export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  /** True if the backend is reachable and the model is usable right now. */
  available(): Promise<boolean>;
  /** Embed a batch of texts. Order-preserving; returns dims-length vectors. */
  embed(texts: string[], role: EmbedRole): Promise<Float32Array[]>;
}

/**
 * Deterministic, network-free provider for tests. Hashes tokens into a
 * fixed-dim bag-of-words vector and L2-normalizes it, so lexically similar
 * texts land near each other — enough to exercise the vector path meaningfully.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fake-hash";
  readonly dims: number;

  constructor(dims = 64) {
    this.dims = dims;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async embed(texts: string[], _role: EmbedRole): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!tok) continue;
      const h = createHash("md5").update(tok).digest();
      const idx = h.readUInt32LE(0) % this.dims;
      v[idx] = v[idx]! + 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
    return v;
  }
}
