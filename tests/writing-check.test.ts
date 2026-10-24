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
    ["blank explanation", { reason: " " }],
    ["missing evidence", { evidence: [] }],
    ["model-supplied chapter", { chapterId: "unrelated-chapter" }],
    ["unknown issue field", { instructions: "rewrite everything" }],
  ])("rejects %s", (_name, patch) => rejects(payload([{ ...factual(), ...patch }])));

  it("derives blocking impact from a verified factual category even when the model says local", () => {
    expect(parseWritingReview(JSON.stringify(payload([{ ...factual(), impact: "local" }])), documents).issues[0])
      .toMatchObject({ category: "character", impact: "blocking", reason: factual().reason });
  });

  it("derives local impact from a prose category without discarding the suggestion", () => {
    expect(parseWritingReview(JSON.stringify(payload([{ ...stylistic(), impact: "blocking" }])), documents).issues[0])
      .toMatchObject({ category: "style", impact: "local", reason: stylistic().reason });
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
  it("accepts a flat JSON transport marker without losing a major decision", () => {
    expect(parseWritingReview(JSON.stringify(payload([], { type:"json_object", majorChange:true, reason:"需要修改已确认主线" })),documents))
      .toEqual(payload([], {majorChange:true,reason:"需要修改已确认主线"}));
  });
  it("retains the rejected review response for diagnostics", () => {
    const raw = JSON.stringify(payload([{ ...stylistic(), evidence: [] }]));
    try { parseWritingReview(raw, documents); throw Error("expected rejection"); }
    catch (error) { expect((error as ProviderError).partial).toBe(raw); }
  });
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
    { issues: [], reason: "必须改变主线" },
    payload([], { majorChange: "false" }),
    payload([], { reason: 1 }),
    payload([], { comment: "passed" }),
  ])("requires the complete declared response schema", raw => rejects(raw));

  it.each([{issues:[]}, {issues:[],majorChange:false}, {issues:[],reason:""}])("defaults absent review decision fields only when no decision was requested", value => {
    expect(parseWritingReview(JSON.stringify(value),documents)).toEqual(payload());
  });

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

it("does not confuse an explicit impossibility with a speculative knowledge claim",()=>{
 const docs:ContextDocument[]=[{source:{kind:"note",id:"secret",revision:1},label:"设定",text:"阿宁没有听过密码，只有林舟知道密码。"},{source:{kind:"chapter",id:"current",revision:1},label:"正文",text:"阿宁没有得到任何提示，却准确说出了密码1234。"}];
 const issue={category:"knowledge",impact:"blocking",reason:"阿宁不可能知道未被告知的密码，但本章明确写出她未经提示就准确说出密码。",evidence:docs.map(d=>({source:d.source,quote:d.text}))};
 expect(parseWritingReview(JSON.stringify(payload([issue])),docs,true).issues).toHaveLength(1);
});

it.each([
  "若去年是十七岁，今年应为十八岁，两句表面成立。但这种年龄表述可能造成困惑，构成事实冲突。",
  "今年十八岁与曾经十七岁可兼容（去年十七岁），若指当前年份则冲突。",
])("keeps a self-compatible or speculative factual finding as an unverified note", reason => {
  const docs: ContextDocument[] = [{ source: { kind: "chapter", id: "current", revision: 1 }, label: "正文", text: "林舟今年十八岁。去年，林舟已经十七岁。" }];
  const issue = { category: "timeline", impact: "blocking", reason, evidence: [
    { quote: "林舟今年十八岁。", source: docs[0].source },
    { quote: "去年，林舟已经十七岁。", source: docs[0].source },
  ] };
  const result = parseWritingReview(JSON.stringify(payload([issue])), docs, true);
  expect(result.issues).toEqual([]);
  expect(result.unverified).toHaveLength(1);
  expect(result.unverified![0]).toContain(reason);
});

it("keeps a direct factual contradiction blocking instead of treating impossibility as speculation", () => {
  const docs: ContextDocument[] = [{ source: { kind: "chapter", id: "current", revision: 1 }, label: "正文", text: "林舟今年十八岁。去年，林舟已经三十岁。" }];
  const issue = { category: "timeline", impact: "blocking", reason: "去年三十岁与今年十八岁不可能同时成立。", evidence: [
    { quote: "林舟今年十八岁。", source: docs[0].source },
    { quote: "去年，林舟已经三十岁。", source: docs[0].source },
  ] };
  expect(parseWritingReview(JSON.stringify(payload([issue])), docs, true).issues).toHaveLength(1);
});

it("keeps a proven conflict blocking when the reason adds a speculative explanation", () => {
  const docs: ContextDocument[] = [{ source: { kind: "chapter", id: "current", revision: 1 }, label: "正文", text: "林舟今年十八岁。去年，林舟已经三十岁。" }];
  const issue = { category: "timeline", impact: "blocking", reason: "去年三十岁与今年十八岁不能同时成立，可能反映记录错误。", evidence: [
    { quote: "林舟今年十八岁。", source: docs[0].source },
    { quote: "去年，林舟已经三十岁。", source: docs[0].source },
  ] };
  expect(parseWritingReview(JSON.stringify(payload([issue])), docs, true).issues).toHaveLength(1);
});
