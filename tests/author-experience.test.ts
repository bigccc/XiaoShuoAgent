import { expect, it } from "vitest";
import { newDocument } from "../src/shared/authoring";
import type { AuthoringState } from "../src/shared/types";
import { authorStep, prepareAuthorMessage, continuationBudget, budgetStopped, authorError } from "../src/renderer/author-experience";

const ready = (): AuthoringState => ({ activeStage: "overview", documents: { overview: newDocument("故事方向已准备") } });
it("confirmation delegates preparation together, preserving modifications and preview requests", () => {
  expect(prepareAuthorMessage("按推荐", ready())).toBe("按推荐，后面的设定和大纲你来定");
  expect(prepareAuthorMessage("先写一段看看", ready())).toBe("先写一段看看");
  expect(prepareAuthorMessage("改一下结局", ready())).toBe("改一下结局");
  expect(prepareAuthorMessage("不要继续", ready())).toBe("不要继续");
});
it("empty, stale, grouped, and already-started works do not receive new delegation", () => {
  const empty = ready(); empty.documents.overview!.content = "";
  const stale = ready(); stale.documents.overview!.needsReview = true;
  const old = ready(); old.writingStarted = true;
  const grouped = ready(); grouped.reviewGroup = ["overview", "settings"];
  for (const state of [empty, stale, old, grouped]) expect(prepareAuthorMessage("继续", state)).toBe("继续");
});
it("groups preparation stages and offers bounded explicit continuation", () => {
  expect(authorStep("settings")).toBe("preparation");
  expect(authorStep("outline")).toBe("preparation");
  expect(continuationBudget(100000, 10000000)).toBe(200000);
  expect(continuationBudget(9900000, 10000000)).toBe(10000000);
});
it("distinguishes exhausted allowance from invalid technical inputs", () => {
  expect(budgetStopped("剩余 Token 预算不足以保留本次完整输入和输出，已有候选稿保留")).toBe(true);
  expect(budgetStopped("任务 Token 预算不正确")).toBe(false);
  expect(authorError("任务 Token 预算不正确")).toBe("任务 Token 预算不正确");
});
