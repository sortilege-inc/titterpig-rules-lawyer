import "dotenv/config";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Store } from "../src/core/store.js";
import { search } from "../src/core/retrieval.js";
import { dbPathFor, defaultProvider } from "../src/core/config.js";
import type { SearchMode } from "../src/core/types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "hybrid" },
    k: { type: "string", default: "8" },
  },
});

const [corpus, ...queryParts] = positionals;
const query = queryParts.join(" ");
if (!corpus || !query) {
  console.error(
    'usage: search.ts <corpus> "<query>" [--mode hybrid|keyword|vector] [--k N]',
  );
  process.exit(2);
}

const dbPath = dbPathFor(corpus);
if (!existsSync(dbPath)) {
  console.error(`no index for "${corpus}" — run: npm run ingest -- --corpus ${corpus}`);
  process.exit(2);
}

const mode = values.mode as SearchMode;
const store = Store.open(dbPath, { readonly: true });
const res = await search(store, {
  query,
  k: Number(values.k),
  mode,
  provider: mode === "keyword" ? undefined : defaultProvider(),
});
store.close();

if (res.degradedToKeyword) console.error(`[degraded] ${res.note}`);
if (res.results.length === 0) {
  console.log("(no matches)");
} else {
  for (const [i, r] of res.results.entries()) {
    const tag = r.parent ? `${r.parent} › ${r.name}` : r.name;
    const src = r.sources.join(", ") || "—";
    console.log(
      `${String(i + 1).padStart(2)}. ${tag}  [${r.kind}]  score=${r.score.toFixed(4)}`,
    );
    console.log(`    sources: ${src}`);
    console.log(`    ${r.snippet}`);
  }
}
