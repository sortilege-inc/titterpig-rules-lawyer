import "dotenv/config";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { ingestCorpus } from "../src/core/ingest.js";
import { findCorpus } from "../src/core/registry.js";
import {
  REGISTRY_PATH,
  INDEX_DIR,
  dbPathFor,
  defaultProvider,
} from "../src/core/config.js";

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    merged: { type: "string" },
    resolved: { type: "string" },
    embed: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

if (!values.corpus) {
  console.error(
    "usage: ingest.ts --corpus <id> [--embed] [--force]\n" +
      "       ingest.ts --corpus <id> --merged <path> --resolved <path> [--embed] [--force]",
  );
  process.exit(2);
}

let mergedPath = values.merged;
let resolvedPath = values.resolved;
if (!mergedPath || !resolvedPath) {
  const entry = findCorpus(REGISTRY_PATH, values.corpus);
  if (!entry) {
    console.error(
      `corpus "${values.corpus}" not found in corpora.json (and no --merged/--resolved given)`,
    );
    process.exit(2);
  }
  mergedPath = entry.merged;
  resolvedPath = entry.resolved;
}

mkdirSync(INDEX_DIR, { recursive: true });

const result = await ingestCorpus({
  corpusId: values.corpus,
  mergedPath,
  resolvedPath,
  dbPath: dbPathFor(values.corpus),
  provider: values.embed ? defaultProvider() : undefined,
  force: values.force,
  log: (m) => console.error(m),
});

if (result.skipped) {
  console.log(`skipped ${result.corpusId} (up to date)`);
} else {
  console.log(
    `indexed ${result.corpusId}: ${result.chunkCount} chunks, ` +
      `${result.entityCount} entities, embedded=${result.embedded}`,
  );
  if (result.embedNote) console.log(`note: ${result.embedNote}`);
  if (values.embed && !result.embedded) {
    console.log("hint: `ollama pull nomic-embed-text` and re-run with --embed");
  }
}
