import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { chunk, extractRefs, stripComments } from "../src/core/chunker.js";
import { loadResolved } from "../src/core/resolved.js";

const FIX = resolve(__dirname, "fixtures");

interface Fixture {
  id: string;
  entities: number;
}
const FIXTURES: Fixture[] = [
  { id: "daggerheart-0.4", entities: 803 },
  { id: "tor2e-0.4", entities: 279 },
];

describe("chunker on real synthesist fixtures", () => {
  for (const f of FIXTURES) {
    describe(f.id, () => {
      const merged = readFileSync(
        resolve(FIX, `${f.id}.merged.ttrpg`),
        "utf8",
      );
      const resolvedIdx = loadResolved(resolve(FIX, `${f.id}.resolved.json`));
      const chunks = chunk(merged, { corpusId: f.id, resolved: resolvedIdx });

      it("emits one top-level chunk per resolved entity (names match exactly)", () => {
        const topNames = new Set(
          chunks.filter((c) => c.parent === null && c.kind !== "block").map((c) => c.name),
        );
        const entityNames = new Set(resolvedIdx.byName.keys());
        expect(topNames).toEqual(entityNames);
        expect(topNames.size).toBe(f.entities);
      });

      it("every chunk's text is a verbatim slice at its recorded lines", () => {
        const lines = merged.split("\n");
        for (const c of chunks) {
          // recorded lines are 1-based inclusive
          const slice = lines.slice(c.lineStart - 1, c.lineEnd).join("\n");
          expect(slice.trimEnd()).toContain(c.text.trimEnd().split("\n")[0]!.trimEnd());
          expect(merged.includes(c.text)).toBe(true);
        }
      });

      it("every chunk has balanced braces", () => {
        for (const c of chunks) {
          let depth = 0;
          let inString = false;
          let inComment = false;
          for (let i = 0; i < c.text.length; i++) {
            const ch = c.text[i]!;
            if (ch === "\n") {
              inComment = false;
              continue;
            }
            if (inComment) continue;
            if (inString) {
              if (ch === "\\") i++;
              else if (ch === '"') inString = false;
              continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "#") {
              // `#word` is an anchor, not a comment (mirror the chunker).
              const next = c.text[i + 1];
              if (!(next !== undefined && /[A-Za-z0-9_]/.test(next)))
                inComment = true;
            } else if (ch === "{") depth++;
            else if (ch === "}") depth--;
          }
          expect(depth, `unbalanced: ${c.name}`).toBe(0);
        }
      });

      it("attaches resolved.json metadata (sources) to entity chunks", () => {
        const withSources = chunks.filter(
          (c) => c.parent === null && c.kind !== "block" && c.sources.length > 0,
        );
        expect(withSources.length).toBeGreaterThan(0);
      });
    });
  }
});

describe("nested-DEF promotion", () => {
  it("promotes DEFs nested in top-level generic blocks (tor2e GAME_STRUCTURE)", () => {
    const merged = readFileSync(resolve(FIX, "tor2e-0.4.merged.ttrpg"), "utf8");
    const resolvedIdx = loadResolved(resolve(FIX, "tor2e-0.4.resolved.json"));
    const chunks = chunk(merged, { corpusId: "tor2e-0.4", resolved: resolvedIdx });
    const promoted = chunks.filter((c) => c.parent !== null);
    expect(promoted.length).toBeGreaterThan(0);
    // e.g. "Adventuring Phase" / "Fellowship Phase" live inside GAME_STRUCTURE
    const names = promoted.map((c) => c.name);
    expect(names).toContain("Adventuring Phase");
  });

  it("does NOT promote nested DEFs inside entity PROPERTIES (daggerheart)", () => {
    const merged = readFileSync(
      resolve(FIX, "daggerheart-0.4.merged.ttrpg"),
      "utf8",
    );
    const resolvedIdx = loadResolved(
      resolve(FIX, "daggerheart-0.4.resolved.json"),
    );
    const chunks = chunk(merged, {
      corpusId: "daggerheart-0.4",
      resolved: resolvedIdx,
    });
    // daggerheart has no top-level generic blocks → no promoted chunks
    expect(chunks.every((c) => c.parent === null)).toBe(true);
    expect(chunks.length).toBe(803);
  });
});

describe("v0.5 GUIDANCE promotion", () => {
  const src = `BASE "x" {
    #tAAAAAAAAAAAAAAAA ^"Real Entity" DEF {
        DESCRIPTION "core mechanic"
        REFERENCES {
            "surface form" -> #tBBBBBBBBBBBBBBBB ^"Some Target"
        }
    }
    GUIDANCE {
        ENTRY ^"Character Creation Summary" #tCCCCCCCCCCCCCCCC {
            CONCERNS [^"Real Entity"]
            TEXT "Step 1. Do the thing. Step 2. Do the other thing."
        }
    }
    GUIDANCE {
        ENTRY ^"Sample Childhoods" #tDDDDDDDDDDDDDDDD {
            TEXT "Some worked examples of childhoods."
        }
    }
}
`;
  const idx = { edition: "x", specVersion: "0.5", entityCount: 1, byName: new Map() };
  const chunks = chunk(src, { corpusId: "t", resolved: idx });

  it("promotes each ENTRY to its own guidance chunk with real name + hash", () => {
    const g = chunks.filter((c) => c.kind === "guidance");
    expect(g.map((c) => c.name).sort()).toEqual([
      "Character Creation Summary",
      "Sample Childhoods",
    ]);
    const summary = g.find((c) => c.name === "Character Creation Summary")!;
    expect(summary.hashId).toBe("tCCCCCCCCCCCCCCCC");
    expect(summary.parent).toBe("GUIDANCE");
    expect(summary.text).toContain("Do the thing");
  });

  it("suppresses the GUIDANCE wrapper (no chunk named GUIDANCE)", () => {
    expect(chunks.some((c) => c.name === "GUIDANCE")).toBe(false);
  });

  it("keeps REFERENCES targets in the entity's caret refs", () => {
    const ent = chunks.find((c) => c.name === "Real Entity")!;
    expect(ent.refs).toContain("Some Target");
  });
});

describe("string / comment state machine", () => {
  it("ignores braces inside strings", () => {
    const src = `BASE "x" {\n    ^"A" DEF {\n        DESCRIPTION "a } brace { inside"\n    }\n}\n`;
    const idx = { edition: "x", specVersion: "", entityCount: 1, byName: new Map() };
    const chunks = chunk(src, { corpusId: "t", resolved: idx });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.name).toBe("A");
  });

  it("ignores braces after # comments", () => {
    const src = `BASE "x" {\n    ^"A" DEF {\n        # a comment with { brace\n        VALUE 1\n    }\n}\n`;
    const idx = { edition: "x", specVersion: "", entityCount: 1, byName: new Map() };
    const chunks = chunk(src, { corpusId: "t", resolved: idx });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.name).toBe("A");
  });

  it("handles multi-line string values", () => {
    const src = `BASE "x" {\n    ^"A" DEF {\n        DESC "line one\n            line two with } and {"\n    }\n}\n`;
    const idx = { edition: "x", specVersion: "", entityCount: 1, byName: new Map() };
    const chunks = chunk(src, { corpusId: "t", resolved: idx });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("line two");
  });
});

describe("extractRefs", () => {
  it("pulls caret refs including escaped form", () => {
    expect(extractRefs('X ^"Foo" and ^\\"Bar\\" done')).toEqual(["Foo", "Bar"]);
  });
  it("dedupes preserving order", () => {
    expect(extractRefs('^"A" ^"B" ^"A"')).toEqual(["A", "B"]);
  });
});

describe("stripComments", () => {
  it("removes full-line and trailing comments but keeps # inside strings", () => {
    const out = stripComments('VALUE "has # inside" # trailing\n# whole line\nKEEP 1');
    expect(out).toContain('VALUE "has # inside"');
    expect(out).not.toContain("trailing");
    expect(out).not.toContain("whole line");
    expect(out).toContain("KEEP 1");
  });
});
