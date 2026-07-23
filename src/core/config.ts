import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OllamaEmbeddingProvider } from "./embeddings/ollama.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";

/** Repo root, derived from this file's location (src/core/config.ts → ../../). */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const REGISTRY_PATH = resolve(REPO_ROOT, "corpora.json");
export const INDEX_DIR = resolve(REPO_ROOT, "data", "index");

export function dbPathFor(corpusId: string): string {
  return resolve(INDEX_DIR, `${corpusId}.db`);
}

/** Construct the default (Ollama) embedding provider from env. */
export function defaultProvider(): EmbeddingProvider {
  return new OllamaEmbeddingProvider({
    baseUrl: process.env.OLLAMA_URL,
    model: process.env.EMBED_MODEL,
  });
}
