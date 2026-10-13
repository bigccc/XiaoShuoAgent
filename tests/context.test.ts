import { describe, expect, it } from "vitest";
import { boundContext, buildContext, type BuiltContext } from "../src/main/context";
import { checkWindows } from "../src/main/check-context";
import { chapter, state } from "./fixtures/recall-cases";

describe("context capacity", () => {
  it("includes versioned remote evidence without replacing the full current chapter", () => {
    const s = state([chapter("c8", 8, "铜钥匙交给老周。"), ...[117,118,119,120].map(i => chapter(`c${i}`, i, "雨落。"))]);
    const built = buildContext(s, "p", {}, ["c120"], [], 24000, false, { query: "铜钥匙", beforeOrdinal: 120 });
    expect(built.documents.some(d => d.reference?.source.id === "c8" && d.text === "铜钥匙交给老周。")).toBe(true);
    expect(built.sources).toContainEqual({ kind:"chapter", id:"c8", revision:1 });
  });
  it("protects a required target before optional records and omits recall that cannot fit intact", () => {
    const reference = { source:{kind:"chapter" as const,id:"old",revision:1}, ordinal:8, title:"旧章", start:0, end:480, excerpt:"钥匙".repeat(240), matchedTerms:["钥匙"] };
    const documents = [
      { source:{kind:"chapter" as const,id:"current",revision:1}, label:"当前正文", text:"甲".repeat(3000), required:true },
      { source:{kind:"note" as const,id:"n",revision:1}, label:"大纲", text:"乙".repeat(8000) },
      { source:reference.source, label:"远章片段", text:reference.excerpt, reference },
    ];
    const bounded = boundContext({ documents, sources:documents.map(d=>d.source), text:"", materials:[], disclosures:[] }, [], 3200);
    expect(bounded.documents.find(d=>d.source.id==="current")!.text).toHaveLength(3000);
    expect(bounded.documents.filter(d=>d.reference)).toEqual([]);
    expect(bounded.text.length).toBeLessThanOrEqual(3200);
  });
  it("keeps reference offsets aligned with the actual passage when a check window splits it", () => {
    const reference = {source:{kind:"chapter" as const,id:"old",revision:1},ordinal:8,title:"旧章",start:25,end:505,excerpt:"钥匙".repeat(240),matchedTerms:["钥匙"]};
    const documents = [{source:reference.source,label:"片段",text:reference.excerpt,reference}];
    const windows = checkWindows({documents,sources:[reference.source],text:"",materials:[],disclosures:[]},400);
    expect(windows.length).toBeGreaterThan(1);
    for(const window of windows) for(const doc of window.documents) {
      expect(doc.reference!.excerpt).toBe(doc.text);
      expect(doc.reference!.end-doc.reference!.start).toBe(doc.text.length);
      expect(reference.excerpt.slice(doc.reference!.start-25,doc.reference!.end-25)).toBe(doc.text);
    }
  });
  it("reuses unused short-document capacity for a long setting", () => {
    const documents = [
      { source: { kind: "project" as const, id: "p", revision: 1 }, label: "作品", text: "短设定" },
      { source: { kind: "note" as const, id: "n", revision: 1 }, label: "大纲", text: "甲".repeat(16000) + "结局关键事实" },
    ];
    const context: BuiltContext = { documents, sources: documents.map(d => d.source), text: "", materials: [], disclosures: [] };
    const bounded = boundContext(context, [], 24000);
    expect(bounded.text).toContain("结局关键事实");
    expect(bounded.disclosures).toEqual([]);
    expect(bounded.text.length).toBeLessThanOrEqual(24000);
  });
  it("covers the source and split-edge quotations with bounded overlapping windows", () => {
    const source = Array.from({ length: 2000 }, (_, i) => String(i).padStart(4, "0") + "。").join("");
    const documents = [{ source: { kind: "note" as const, id: "n", revision: 7 }, label: "长设定", text: source }];
    const windows = checkWindows({ documents, sources: documents.map(d => d.source), text: "", materials: [], disclosures: [] }, 2000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every(w => w.text.length <= 2000)).toBe(true);
    for (let i = 0; i < source.length; i += 75) {
      expect(windows.some(w => w.documents.some(d => d.text.includes(source.slice(i, i + 100))))).toBe(true);
    }
    expect(windows.at(-1)!.text.endsWith("1999。")).toBe(true);
  });
});
