import { describe, it, expect } from "vitest";
import { OllamaEmbeddingProvider } from "../src/core/embeddings/ollama.js";

/**
 * Live tests against a local Ollama with nomic-embed-text pulled. Skipped
 * automatically when the backend/model is not available, so CI without a GPU
 * box stays green.
 */
const provider = new OllamaEmbeddingProvider({
  baseUrl: process.env.OLLAMA_URL,
  model: process.env.EMBED_MODEL,
});
const LIVE = await provider.available();

describe.skipIf(!LIVE)("Ollama embeddings (live)", () => {
  it("embeds a batch and returns model-dim vectors", async () => {
    const vecs = await provider.embed(
      ["When you mark your last Stress, you take a Scar.", "A d12 duality roll."],
      "document",
    );
    expect(vecs).toHaveLength(2);
    expect(vecs[0]!.length).toBe(provider.dims);
    // vectors should be non-degenerate
    const norm = Math.sqrt(vecs[0]!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0);
  }, 60_000); // allow for cold model load

  it("applies distinct query vs document prefixes without error", async () => {
    const [q] = await provider.embed(["mark stress"], "query");
    const [d] = await provider.embed(["mark stress"], "document");
    expect(q!.length).toBe(provider.dims);
    expect(d!.length).toBe(provider.dims);
  }, 60_000);
});

describe("Ollama provider offline behaviour", () => {
  it("reports unavailable for a dead endpoint (no throw)", async () => {
    const dead = new OllamaEmbeddingProvider({
      baseUrl: "http://127.0.0.1:1",
    });
    expect(await dead.available()).toBe(false);
  });
});
