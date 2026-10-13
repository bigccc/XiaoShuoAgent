import { describe, expect, it } from "vitest";
import { recallPassages } from "../src/main/recall";
import type { AppState, Chapter, Note } from "../src/shared/types";

import { chapter, state, meta } from "./fixtures/recall-cases";

describe("versioned remote chapter recall", () => {
  it("selects later combined evidence instead of only the first mention of each keyword", () => {
    const s=state([chapter("c8",8,"铜钥匙落满灰尘。"+"甲".repeat(600)+"老周一直在等待。"+"乙".repeat(600)+"铜钥匙被交到老周手中。")]);
    const refs=recallPassages(s,"p",{query:"铜钥匙 老周",beforeOrdinal:120});
    expect(refs).toHaveLength(1);
    expect(refs[0].excerpt).toContain("铜钥匙被交到老周手中。");
    expect(refs[0].matchedTerms).toContain("老周");
  });
  it("finds the chapter-eight transfer beyond the recent window with exact original offsets", () => {
    const s = state([chapter("c8", 8, "雨落。".repeat(300) + "阿宁将铜钥匙交给老周。" + "灯亮。".repeat(300)), chapter("c119", 119, "阿宁走进大厅。")]);
    const result = recallPassages(s, "p", { query: "铜钥匙现在在谁手里", beforeOrdinal: 120, excludeChapterIds: ["c119"] });
    expect(result.map(r => r.source.id)).toEqual(["c8"]);
    const r = result[0];
    expect(r.excerpt).toContain("阿宁将铜钥匙交给老周。");
    expect(r.excerpt).toBe(s.chapters[0].content.slice(r.start, r.end));
    expect(r.source.revision).toBe(1);
    expect(r.excerpt.length).toBeLessThanOrEqual(480);
  });
  it("excludes future, unconfirmed, stale, explicitly excluded and other-project chapters", () => {
    const s = state([
      chapter("good", 8, "铜钥匙在老周手里。"), chapter("future", 121, "铜钥匙在阿宁手里。"),
      chapter("same", 120, "铜钥匙被丢弃。"), chapter("draft", 7, "铜钥匙在王五手里。", { status: "draft" }),
      chapter("stale", 6, "铜钥匙在赵六手里。", { needsReview: true }),
      chapter("foreign", 5, "铜钥匙在某人手里。", { projectId: "other" }), chapter("excluded", 9, "铜钥匙消失。"),
    ]);
    expect(recallPassages(s, "p", { query: "铜钥匙", beforeOrdinal: 120, excludeChapterIds: ["excluded"] }).map(r => r.source.id)).toEqual(["good"]);
  });
  it("uses a relevant character alias but not a stale or future-derived character record", () => {
    const person: Note = { ...meta, id: "n", projectId: "p", type: "character", title: "阿宁", body: "别名：小宁、宁姑娘\n目标：寻找家人。", sources: [], needsReview: false };
    const s = state([chapter("alias", 8, "小宁将铜钥匙交给老周。")], [person]);
    expect(recallPassages(s, "p", { query: "阿宁当时做了什么", beforeOrdinal: 120 }).map(r => r.source.id)).toEqual(["alias"]);
    s.notes[0].needsReview = true;
    expect(recallPassages(s, "p", { query: "阿宁当时做了什么", beforeOrdinal: 120 })).toEqual([]);
    s.notes[0].needsReview = false;
    s.notes[0].sources = [{ kind: "chapter", id: "future", revision: 1 }];
    s.chapters.push(chapter("future", 121, "未来秘密。"));
    expect(recallPassages(s, "p", { query: "阿宁当时做了什么", beforeOrdinal: 120 })).toEqual([]);
  });
  it("does not turn generic execution language or an empty query into reading the entire book", () => {
    const s = state([chapter("old", 1, "继续写故事，开始正文。")]);
    for (const query of ["", "继续写一章", "按推荐继续", "写完前五章"]) expect(recallPassages(s, "p", { query, beforeOrdinal: 120 })).toEqual([]);
  });
  it("recomputes from the current revision after editing, restoring or deleting a source", () => {
    const s = state([chapter("c8", 8, "铜钥匙在老周手中。")]);
    expect(recallPassages(s, "p", { query: "铜钥匙", beforeOrdinal: 120 })[0].excerpt).toContain("老周");
    s.chapters[0] = { ...s.chapters[0], revision: 2, content: "铜钥匙已交给阿宁。" };
    const changed = recallPassages(s, "p", { query: "铜钥匙", beforeOrdinal: 120 })[0];
    expect(changed.source.revision).toBe(2); expect(changed.excerpt).not.toContain("老周");
    s.chapters[0] = { ...s.chapters[0], revision: 3, content: "铜钥匙在老周手中。" };
    expect(recallPassages(s, "p", { query: "铜钥匙", beforeOrdinal: 120 })[0].source.revision).toBe(3);
    s.chapters = [];
    expect(recallPassages(s, "p", { query: "铜钥匙", beforeOrdinal: 120 })).toEqual([]);
  });
  it("ranks combined evidence ahead of incidental matches and bounds repeated matches across chapters", () => {
    const s = state([chapter("relevant", 8, "阿宁把铜钥匙交给老周。"), ...Array.from({ length: 20 }, (_, i) => chapter(`noise${i}`, i + 20, "普通钥匙。".repeat(1000)))]);
    const result = recallPassages(s, "p", { query: "阿宁 铜钥匙 老周", beforeOrdinal: 120 });
    expect(result[0].source.id).toBe("relevant");
    expect(result.length).toBeLessThanOrEqual(6);
    expect(new Set(result.map(r => r.source.id)).size).toBe(result.length);
    expect(result.reduce((n, r) => n + r.excerpt.length, 0)).toBeLessThanOrEqual(2880);
    expect(recallPassages(s, "p", { query: "阿宁 铜钥匙 老周", beforeOrdinal: 120 })).toEqual(result);
  });
});
