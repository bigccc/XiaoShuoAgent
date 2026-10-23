import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/main/store";
import { DomainService } from "../src/main/domain";
import { ReadingService } from "../src/main/reading";
import { DomainError } from "../src/shared/validation";
import * as reader from "../src/shared/reader";
import type {
  ReaderCommand,
  ReadingReview,
  TextSelection,
} from "../src/shared/reader";
import type {
  Chapter,
  ChapterVersion,
  CommandResult,
} from "../src/shared/types";

const directories: string[] = [];
let store: Store;
let domain: DomainService;
beforeEach(() => {
  store = new Store(":memory:");
  domain = new DomainService(store);
});
afterEach(() => {
  store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function success(result: CommandResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}
function project() {
  return success(domain.execute({ type: "project.create", title: "阅读测试" }))
    .entityId;
}
function chapter(
  projectId: string,
  content = "前文。相同句。后文。相同句。",
  ordinal = 1,
) {
  const id = success(
    domain.execute({
      type: "chapter.create",
      projectId,
      ordinal,
      title: `第${ordinal}章`,
    }),
  ).entityId;
  success(domain.execute({ type: "chapter.save", id, revision: 1, content }));
  return store.get("chapters", id)!;
}
function workspace(projectId: string) {
  return store.selectByProject("readingWorkspaces", projectId)[0];
}
function service() {
  return new ReadingService(store, domain);
}
function selection(c: Chapter, start = 3, end = 7): TextSelection {
  return {
    chapterId: c.id,
    revision: c.revision,
    start,
    end,
    quote: c.content.slice(start, end),
  };
}
function expectError(fn: () => unknown, code: DomainError["code"]) {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect((thrown as DomainError).code).toBe(code);
}

it("persists the exact second duplicate quote and requires manual annotation resolution", () => {
  const projectId = project(),
    c = chapter(projectId),
    read = service();
  const anchor = selection(c, 10, 14);
  const created = success(
    read.dispatch({
      type: "reading.annotate",
      projectId,
      selection: anchor,
      text: "需要改写",
    }),
  );
  const saved = workspace(projectId)!;
  expect(saved.id).not.toBe(projectId);
  expect(saved.annotations[0]).toMatchObject({
    id: created.entityId,
    chapterId: c.id,
    anchor,
    text: "需要改写",
    status: "open",
  });
  expect(saved.annotations[0].contentHash).toBe(
    createHash("sha256").update(c.content).digest("hex"),
  );
  success(
    domain.execute({
      type: "chapter.save",
      id: c.id,
      revision: c.revision,
      content: "新的段落",
    }),
  );
  expect(workspace(projectId)!.annotations[0].status).toBe("open");
  success(
    read.dispatch({
      type: "reading.annotationStatus",
      projectId,
      id: created.entityId,
      status: "resolved",
    }),
  );
  expect(workspace(projectId)!.annotations[0].status).toBe("resolved");
  success(
    read.dispatch({
      type: "reading.annotationStatus",
      projectId,
      id: created.entityId,
      status: "open",
    }),
  );
  expect(workspace(projectId)!.annotations[0].status).toBe("open");
});

it("rejects stale selection revisions without creating a workspace", () => {
  const projectId = project(),
    c = chapter(projectId),
    read = service();
  success(
    domain.execute({
      type: "chapter.save",
      id: c.id,
      revision: c.revision,
      content: c.content,
    }),
  );
  expectError(
    () =>
      read.dispatch({
        type: "reading.annotate",
        projectId,
        selection: selection(c),
        text: "旧版本",
      }),
    "CONFLICT",
  );
  expect(workspace(projectId)).toBeUndefined();
});

it("rejects mismatched quotes and offsets without affecting annotations", () => {
  const projectId = project(),
    c = chapter(projectId),
    read = service();
  for (const anchor of [
    { ...selection(c), quote: "不存在" },
    { ...selection(c), start: -1 },
    { ...selection(c), end: c.content.length + 1 },
    { ...selection(c), start: 7, end: 7, quote: "" },
    { ...selection(c), start: 3.5 },
  ])
    expectError(
      () =>
        read.dispatch({
          type: "reading.annotate",
          projectId,
          selection: anchor,
          text: "批注",
        }),
      "VALIDATION",
    );
  expect(workspace(projectId)).toBeUndefined();
});
it("rejects annotation text larger than the portable backup limit", () => {
  const projectId = project(),
    c = chapter(projectId),
    read = service();
  expectError(
    () =>
      read.dispatch({
        type: "reading.annotate",
        projectId,
        selection: selection(c),
        text: "长".repeat(10001),
      }),
    "VALIDATION",
  );
  expect(workspace(projectId)).toBeUndefined();
});

it("rejects chapter references belonging to a different project", () => {
  const projectId = project(),
    foreign = chapter(project()),
    read = service();
  for (const command of [
    {
      type: "reading.annotate",
      projectId,
      selection: selection(foreign),
      text: "错误作品",
    },
    {
      type: "reading.review",
      projectId,
      chapterId: foreign.id,
      revision: foreign.revision,
    },
    {
      type: "reading.position",
      projectId,
      chapterId: foreign.id,
      offset: 0,
      mode: "reading",
    },
  ] as ReaderCommand[])
    expectError(() => read.dispatch(command), "VALIDATION");
  expect(workspace(projectId)).toBeUndefined();
});

it("binds review to the current prose version and updates a single baseline on rereview", () => {
  const projectId = project(),
    c = chapter(projectId, "原文"),
    read = service();
  success(
    read.dispatch({
      type: "reading.review",
      projectId,
      chapterId: c.id,
      revision: c.revision,
    }),
  );
  const baseline = workspace(projectId)!.reviews[0];
  expect(store.get("versions", baseline.versionId)).toMatchObject({
    chapterId: c.id,
    chapterRevision: c.revision,
    content: "原文",
  });
  success(
    domain.execute({
      type: "chapter.save",
      id: c.id,
      revision: c.revision,
      content: "改后正文",
    }),
  );
  expect(workspace(projectId)!.reviews[0]).toEqual(baseline);
  success(
    read.dispatch({
      type: "reading.review",
      projectId,
      chapterId: c.id,
      revision: c.revision + 1,
    }),
  );
  const reviews = workspace(projectId)!.reviews;
  expect(reviews).toHaveLength(1);
  expect(store.get("versions", reviews[0].versionId)!.content).toBe("改后正文");
});

it("finds the real prose baseline when upstream invalidation changes only chapter revision", () => {
  const projectId = project(),
    first = chapter(projectId, "第一章", 1),
    second = chapter(projectId, "第二章", 2),
    read = service();
  success(
    domain.execute({
      type: "chapter.save",
      id: first.id,
      revision: first.revision,
      content: "第一章修改",
    }),
  );
  const current = store.get("chapters", second.id)!;
  expect(current.revision).toBeGreaterThan(second.revision);
  success(
    read.dispatch({
      type: "reading.review",
      projectId,
      chapterId: current.id,
      revision: current.revision,
    }),
  );
  const review = workspace(projectId)!.reviews[0];
  expect(review.revision).toBe(current.revision);
  expect(store.get("versions", review.versionId)!.content).toBe("第二章");
});

it("refuses stale review commands and unrelated candidate versions", () => {
  const projectId = project(),
    c = chapter(projectId, "作者正文"),
    read = service();
  success(
    domain.saveCandidate({
      chapterId: c.id,
      taskId: "task",
      content: "候选正文",
      sourceRevisions: [{ kind: "chapter", id: c.id, revision: c.revision }],
    }),
  );
  expectError(
    () =>
      read.dispatch({
        type: "reading.review",
        projectId,
        chapterId: c.id,
        revision: 1,
      }),
    "CONFLICT",
  );
  success(
    read.dispatch({
      type: "reading.review",
      projectId,
      chapterId: c.id,
      revision: c.revision,
    }),
  );
  const versionId = workspace(projectId)!.reviews[0].versionId;
  expect(store.get("versions", versionId)).toMatchObject({
    content: "作者正文",
    reason: "save",
  });
});

it("builds and edits nonoverlapping volumes without moving chapters", () => {
  const projectId = project(),
    read = service();
  for (let i = 1; i <= 4; i++) chapter(projectId, `正文${i}`, i);
  const before = store.selectByProject("chapters", projectId);
  const a = success(
    read.dispatch({
      type: "reading.volumeSave",
      projectId,
      title: "第一卷",
      fromOrdinal: 1,
      toOrdinal: 2,
    }),
  );
  success(
    read.dispatch({
      type: "reading.volumeSave",
      projectId,
      title: "第二卷",
      fromOrdinal: 3,
      toOrdinal: 4,
    }),
  );
  expectError(
    () =>
      read.dispatch({
        type: "reading.volumeSave",
        projectId,
        title: "重叠卷",
        fromOrdinal: 2,
        toOrdinal: 3,
      }),
    "VALIDATION",
  );
  success(
    read.dispatch({
      type: "reading.volumeSave",
      projectId,
      id: a.entityId,
      title: "首卷",
      fromOrdinal: 1,
      toOrdinal: 2,
    }),
  );
  expect(workspace(projectId)!.volumes).toHaveLength(2);
  expect(store.selectByProject("chapters", projectId)).toEqual(before);
  success(
    read.dispatch({ type: "reading.volumeDelete", projectId, id: a.entityId }),
  );
  expect(workspace(projectId)!.volumes.map((v) => v.title)).toEqual(["第二卷"]);
});

it("requires actual chapter boundaries and rejects missing volume and annotation ids", () => {
  const projectId = project(),
    read = service();
  chapter(projectId, "甲", 1);
  chapter(projectId, "乙", 3);
  expectError(
    () =>
      read.dispatch({
        type: "reading.volumeSave",
        projectId,
        title: "空边界",
        fromOrdinal: 1,
        toOrdinal: 2,
      }),
    "VALIDATION",
  );
  expectError(
    () =>
      read.dispatch({ type: "reading.volumeDelete", projectId, id: "missing" }),
    "NOT_FOUND",
  );
  expectError(
    () =>
      read.dispatch({
        type: "reading.volumeSave",
        projectId,
        id: "missing",
        title: "不存在",
        fromOrdinal: 1,
        toOrdinal: 3,
      }),
    "NOT_FOUND",
  );
  expectError(
    () =>
      read.dispatch({
        type: "reading.annotationStatus",
        projectId,
        id: "missing",
        status: "resolved",
      }),
    "NOT_FOUND",
  );
  expect(workspace(projectId)).toBeUndefined();
});

it("persists reading position across database reopen and clamps to prose length", () => {
  const dir = mkdtempSync(join(tmpdir(), "novel-reader-"));
  directories.push(dir);
  store.close();
  store = new Store(join(dir, "reader.sqlite"));
  domain = new DomainService(store);
  const projectId = project(),
    c = chapter(projectId, "五个中文字"),
    read = service();
  success(
    read.dispatch({
      type: "reading.position",
      projectId,
      chapterId: c.id,
      offset: 999,
      mode: "review",
    }),
  );
  store.close();
  store = new Store(join(dir, "reader.sqlite"));
  expect(workspace(projectId)!.position).toEqual({
    chapterId: c.id,
    offset: 5,
    mode: "review",
  });
  success(
    new ReadingService(store, new DomainService(store)).dispatch({
      type: "reading.position",
      projectId,
      chapterId: c.id,
      offset: -20,
      mode: "reading",
    }),
  );
  expect(workspace(projectId)!.position!.offset).toBe(0);
});

it("validates all runtime command fields and leaves storage unchanged", () => {
  const projectId = project(),
    c = chapter(projectId),
    read = service();
  for (const command of [
    null,
    { type: "reading.unknown", projectId },
    {
      type: "reading.position",
      projectId,
      chapterId: c.id,
      offset: Number.NaN,
      mode: "reading",
    },
    {
      type: "reading.position",
      projectId,
      chapterId: c.id,
      offset: 1.5,
      mode: "reading",
    },
    {
      type: "reading.position",
      projectId,
      chapterId: c.id,
      offset: 0,
      mode: "unknown",
    },
    {
      type: "reading.annotate",
      projectId,
      selection: selection(c),
      text: "   ",
    },
    {
      type: "reading.annotate",
      projectId,
      selection: { ...selection(c), secret: "no" },
      text: "批注",
    },
    { type: "reading.review", projectId, chapterId: c.id, revision: 0 },
    {
      type: "reading.volumeSave",
      projectId,
      title: "卷",
      fromOrdinal: 2,
      toOrdinal: 1,
    },
    {
      type: "reading.volumeSave",
      projectId,
      title: "卷",
      fromOrdinal: 0,
      toOrdinal: 1,
    },
    { type: "reading.annotationStatus", projectId, id: "id", status: "done" },
    {
      type: "reading.review",
      projectId,
      chapterId: c.id,
      revision: c.revision,
      extra: true,
    },
  ])
    expectError(() => read.dispatch(command as ReaderCommand), "VALIDATION");
  expect(workspace(projectId)).toBeUndefined();
});

it("searches literal punctuation with exact offsets, ordered chapters and bounded pages", () => {
  const projectId = project(),
    read = service();
  const second = chapter(projectId, "%_重复".repeat(45), 2),
    first = chapter(projectId, "甲%_乙", 1);
  chapter(project(), "%_其他作品");
  const page = read.search(projectId, "%_");
  expect(page.total).toBe(46);
  expect(page.matches).toHaveLength(40);
  expect(page.nextOffset).toBe(40);
  expect(page.matches[0]).toMatchObject({
    chapterId: first.id,
    start: 1,
    end: 3,
    revision: first.revision,
  });
  const last = read.search(projectId, "%_", page.nextOffset!);
  expect(last.matches).toHaveLength(6);
  expect(last.nextOffset).toBeNull();
  expect(last.matches.every((m) => m.chapterId === second.id)).toBe(true);
  expect(read.search(projectId, "不存在")).toEqual({
    matches: [],
    total: 0,
    nextOffset: null,
  });
});

it("rejects malformed search and unknown project before querying", () => {
  const projectId = project(),
    read = service();
  for (const [query, offset] of [
    ["", 0],
    [" ", 0],
    [null, 0],
    ["正文", -1],
    ["正文", 0.2],
  ] as const)
    expectError(
      () => read.search(projectId, query as string, offset),
      "VALIDATION",
    );
  expectError(() => read.search("missing", "正文"), "NOT_FOUND");
});

it("locates original duplicate offsets only with the original source revision", () => {
  const locate = reader.locateSelection;
  const anchor = {
    chapterId: "c",
    revision: 2,
    start: 3,
    end: 5,
    quote: "相同",
  };
  expect(locate("相同。相同", anchor, 2)).toEqual({ start: 3, end: 5 });
  expect(locate("相同。相同", anchor, 3)).toBeNull();
  expect(locate("相同。相同", anchor)).toBeNull();
  expect(locate("新增。相同", anchor, 3)).toEqual({ start: 3, end: 5 });
  expect(locate("被删掉", anchor, 3)).toBeNull();
  expect(locate("错误相同", anchor, 2)).toBeNull();
});

it("detects overlapping duplicate quote ambiguity and invalid helper ranges", () => {
  const locate = reader.locateSelection;
  expect(
    locate(
      "aaa",
      { chapterId: "c", revision: 2, start: 0, end: 2, quote: "aa" },
      3,
    ),
  ).toBeNull();
  expect(
    locate(
      "唯一",
      { chapterId: "c", revision: 2, start: -1, end: 2, quote: "唯一" },
      3,
    ),
  ).toBeNull();
});

it("derives review status from baseline prose, including unknown baselines", () => {
  const status = reader.reviewStatus;
  const c = { id: "chapter", content: "已审正文", revision: 9 };
  const review: ReadingReview = {
    chapterId: c.id,
    revision: 2,
    versionId: "baseline",
    reviewedAt: "2026-10-11",
  };
  const baseline = {
    id: "baseline",
    chapterId: c.id,
    content: "已审正文",
  } as ChapterVersion;
  expect(status(c)).toBe("unreviewed");
  expect(status(c, review, baseline)).toBe("reviewed");
  expect(status({ ...c, content: "改后正文" }, review, baseline)).toBe(
    "needs-review",
  );
  expect(status(c, review)).toBe("needs-review");
  expect(status(c, review, { ...baseline, chapterId: "foreign" })).toBe(
    "needs-review",
  );
  expect(status(c, review, { ...baseline, id: "wrong-version" })).toBe(
    "needs-review",
  );
});
