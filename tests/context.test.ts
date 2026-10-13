import { describe, expect, it } from "vitest";
import { boundContext, type BuiltContext } from "../src/main/context";
import { checkWindows } from "../src/main/check-context";

describe("context capacity", () => {
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
