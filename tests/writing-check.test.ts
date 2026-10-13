import { describe, expect, it } from "vitest";
import type { ContextDocument } from "../src/main/context";
import { ProviderError } from "../src/main/provider";
import { parseWritingReview } from "../src/main/writing-check";

const documents: ContextDocument[] = [
  {
    source: { kind: "note", id: "cast", revision: 7 },
    label: "已确认人设",
    text: "苏青今年十七岁。她不识水性。",
  },
  {
    source: { kind: "chapter", id: "chapter-1", revision: 3 },
    label: "第一章",
    text: "苏青今年十七岁。风吹过\n空旷的庭院。",
  },
  {
    source: { kind: "chapter", id: "chapter-2", revision: 9 },
    label: "第二章",
    text: "同一天，苏青刚满二十岁。她站着，一动不动地站着。",
  },
];
const evidence = (index: number, quote: string) => ({
  quote,
  source: { ...documents[index].source },
});
const factual = () => ({
  category: "character",
  impact: "blocking",
  reason: "同一天人物年龄分别被叙述为十七岁与二十岁。",
  evidence: [evidence(0, "苏青今年十七岁。"), evidence(2, "同一天，苏青刚满二十岁。")],
});
const stylistic = () => ({
  category: "style",
  impact: "local",
  reason: "同一句重复描述站立状态。",
  evidence: [evidence(2, "她站着，一动不动地站着。")],
});
const payload = (issues: unknown[] = [], extras: Record<string, unknown> = {}) => ({
  issues,
  majorChange: false,
  reason: "",
  ...extras,
});
function rejects(value: unknown) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  expect(() => parseWritingReview(raw, documents)).toThrow(ProviderError);
  try {
    parseWritingReview(raw, documents);
  } catch (error) {
    expect((error as ProviderError).code).toBe("FORMAT");
  }
}

describe("continuous writing review evidence", () => {
  it("accepts verified factual conflicts and locates the last chapter evidence", () => {
    const issue = factual();
    issue.evidence.unshift(evidence(1, "苏青今年十七岁。"));
    const result = parseWritingReview(JSON.stringify(payload([issue])), documents);
    expect(result).toEqual({
      issues: [{ ...issue, chapterId: "chapter-2" }],
      majorChange: false,
      reason: "",
    });
  });

  it("accepts local prose suggestions with one quotation", () => {
    const issue = stylistic();
    expect(parseWritingReview(JSON.stringify(payload([issue])), documents).issues)
      .toEqual([{ ...issue, chapterId: "chapter-2" }]);
  });

  it("leaves chapterId absent for conflicts confined to notes", () => {
    const issue = factual();
    const notes: ContextDocument[] = [documents[0], {
      source: { kind: "note", id: "cast-old", revision: 2 },
      label: "另一设定",
      text: "苏青今年二十岁。",
    }];
    issue.evidence[1] = { quote: notes[1].text, source: notes[1].source };
    expect(parseWritingReview(JSON.stringify(payload([issue])), notes).issues[0])
      .not.toHaveProperty("chapterId");
  });

  it("restores unique whitespace differences to the exact source quotation", () => {
    const issue = stylistic();
    issue.evidence = [evidence(1, "风吹过空旷的庭院。")];
    expect(parseWritingReview(JSON.stringify(payload([issue])), documents).issues[0].evidence[0].quote)
      .toBe("风吹过\n空旷的庭院。");
  });

  it("does not use ambiguous whitespace-normalized quotations", () => {
    const issue = stylistic();
    issue.evidence = [evidence(1, "风吹过空旷的庭院。")];
    const ambiguous = documents.map(doc => doc.source.id === "chapter-1"
      ? { ...doc, text: "风吹过\n空旷的庭院。风吹过 空旷的庭院。" }
      : doc);
    expect(() => parseWritingReview(JSON.stringify(payload([issue])), ambiguous)).toThrow(ProviderError);
  });

  it.each([
    ["fabricated quotation", { quote: "苏青今年十八岁。" }],
    ["stale version", { source: { kind: "chapter", id: "chapter-2", revision: 8 } }],
    ["other project chapter", { source: { kind: "chapter", id: "unrelated-chapter", revision: 9 } }],
    ["wrong source kind", { source: { kind: "note", id: "chapter-2", revision: 9 } }],
    ["noninteger revision", { source: { kind: "chapter", id: "chapter-2", revision: 9.5 } }],
    ["blank quotation", { quote: " \n " }],
    ["unknown evidence property", { explanation: "trust me" }],
    ["unknown source property", { source: { ...documents[2].source, projectId: "elsewhere" } }],
  ])("rejects %s without allowing a repair based on it", (_name, patch) => {
    const issue = stylistic();
    rejects(payload([{ ...issue, evidence: [{ ...issue.evidence[0], ...patch }] }]));
  });

  it("requires both sides of a factual conflict", () => {
    const issue = factual();
    issue.evidence.pop();
    rejects(payload([issue]));
  });

  it("does not count repeated evidence as both sides of a conflict", () => {
    const issue = factual();
    issue.evidence = [issue.evidence[0], issue.evidence[0]];
    rejects(payload([issue]));
  });

  it.each([
    ["unknown category", { category: "location" }],
    ["unknown impact", { impact: "warning" }],
    ["downgraded factual conflict", { impact: "local" }],
    ["blank explanation", { reason: " " }],
    ["missing evidence", { evidence: [] }],
    ["model-supplied chapter", { chapterId: "unrelated-chapter" }],
    ["unknown issue field", { instructions: "rewrite everything" }],
  ])("rejects %s", (_name, patch) => rejects(payload([{ ...factual(), ...patch }])));

  it("does not allow a prose suggestion to halt the task as a factual conflict", () => {
    rejects(payload([{ ...stylistic(), impact: "blocking" }]));
  });

  it.each(["timeline", "plot", "world", "knowledge", "foreshadowing"])(
    "supports the %s factual category", category => {
      const issue = { ...factual(), category };
      expect(parseWritingReview(JSON.stringify(payload([issue])), documents).issues[0].category).toBe(category);
    },
  );
  it.each(["pacing", "length"])("supports the %s local category", category => {
    const issue = { ...stylistic(), category };
    expect(parseWritingReview(JSON.stringify(payload([issue])), documents).issues[0].category).toBe(category);
  });
});

describe("continuous writing review response boundary", () => {
  it("accepts a complete empty check and standard JSON fences", () => {
    const raw = JSON.stringify(payload());
    for (const text of [raw, ` \n${raw}\n `, `\x60\x60\x60json\n${raw}\n\x60\x60\x60`, `\x60\x60\x60\n${raw}\n\x60\x60\x60`]) {
      expect(parseWritingReview(text, documents)).toEqual(payload());
    }
  });

  it.each([
    '前言 {"issues":[],"majorChange":false,"reason":""}',
    '{"issues":[],"majorChange":false,"reason":""} {"majorChange":true,"reason":"改人设"}',
    '{"issues":[],"majorChange":false,"reason":""},"majorChange":true',
    '```json\n{"issues":[],"majorChange":false,"reason":""}\n```\n追加说明',
    '{"issues":[],"majorChange":false,"reason":"",}',
    '[]',
    'null',
  ])("rejects incomplete or extra output: %s", raw => rejects(raw));

  it.each([
    { issues: [] },
    payload([], { majorChange: "false" }),
    payload([], { reason: 1 }),
    payload([], { comment: "passed" }),
  ])("requires the complete declared response schema", raw => rejects(raw));

  it("preserves a reasoned major creative change for an author decision", () => {
    const change = payload([], { majorChange: true, reason: "需要推翻已确认的主线结局才能继续。" });
    expect(parseWritingReview(JSON.stringify(change), documents)).toEqual(change);
  });

  it("does not accept a reasonless major change", () => {
    rejects(payload([], { majorChange: true, reason: "  " }));
  });

  it("rejects oversized results instead of silently truncating issues", () => {
    rejects(payload(Array.from({ length: 21 }, stylistic)));
    rejects(payload([{ ...stylistic(), reason: "长".repeat(2001) }]));
    rejects(payload([{ ...stylistic(), evidence: Array.from({ length: 11 }, () => evidence(2, "她站着，一动不动地站着。")) }]));
    rejects(" ".repeat(262145) + JSON.stringify(payload()));
  });
});
