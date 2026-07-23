import "dotenv/config";
import { existsSync } from "node:fs";
import { loadRegistry } from "../src/core/registry.js";
import { Store } from "../src/core/store.js";
import { REGISTRY_PATH, dbPathFor } from "../src/core/config.js";
import { getActiveCorpus } from "../src/core/session.js";

const entries = loadRegistry(REGISTRY_PATH);
if (entries.length === 0) {
  console.log("no corpora registered in corpora.json");
  process.exit(0);
}

const { corpus: active, pinned } = getActiveCorpus();

for (const e of entries) {
  const mark = e.id === active ? (pinned ? "📌" : " *") : "  ";
  const dbPath = dbPathFor(e.id);
  if (!existsSync(dbPath)) {
    console.log(`${mark} ${e.id}  —  not indexed (run: npm run ingest -- --corpus ${e.id})`);
    continue;
  }
  const store = Store.open(dbPath, { readonly: true });
  const m = store.meta();
  store.close();
  const vec = m.vectorReady ? `vectors:${m.embedModel}(${m.embedDims})` : "keyword-only";
  console.log(
    `${mark} ${e.id}  —  ${m.edition} spec ${m.specVersion}  ·  ` +
      `${m.entityCount} entities, ${m.chunkCount} chunks  ·  ${vec}  ·  built ${m.builtAt}`,
  );
}

if (active) {
  console.log(`\nin scope: ${active}${pinned ? "  (pinned via RULES_LAWYER_CORPUS)" : ""}`);
} else {
  console.log(`\nno corpus in scope — set one: npm run use -- <corpus>`);
}
