import "dotenv/config";
import { existsSync } from "node:fs";
import { loadRegistry } from "../src/core/registry.js";
import { REGISTRY_PATH, dbPathFor } from "../src/core/config.js";
import {
  getActiveCorpus,
  setActiveCorpus,
  clearActiveCorpus,
} from "../src/core/session.js";

// npm run use                → print the in-scope corpus
// npm run use -- <corpus>    → put <corpus> in scope
// npm run use -- --clear     → clear the selection
const arg = process.argv[2];

if (!arg) {
  const { corpus, pinned } = getActiveCorpus();
  if (!corpus) {
    console.log("no corpus in scope. set one: npm run use -- <corpus>");
  } else {
    console.log(`in scope: ${corpus}${pinned ? "  (pinned via RULES_LAWYER_CORPUS)" : ""}`);
  }
  process.exit(0);
}

const { pinned } = getActiveCorpus();
if (pinned) {
  console.error(
    "session is pinned via RULES_LAWYER_CORPUS; unset that env var to change scope from the CLI.",
  );
  process.exit(2);
}

if (arg === "--clear") {
  clearActiveCorpus();
  console.log("scope cleared.");
  process.exit(0);
}

const known = new Set(loadRegistry(REGISTRY_PATH).map((e) => e.id));
if (!known.has(arg)) {
  console.error(`unknown corpus "${arg}". registered: ${[...known].join(", ") || "(none)"}`);
  process.exit(2);
}
if (!existsSync(dbPathFor(arg))) {
  console.error(`"${arg}" is not indexed yet — run: npm run ingest -- --corpus ${arg} --embed`);
  process.exit(2);
}

setActiveCorpus(arg);
console.log(`in scope: ${arg}`);
