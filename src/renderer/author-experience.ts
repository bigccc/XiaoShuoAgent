import type { AuthoringStage, AuthoringState } from "../shared/types";

export function authorStep(stage: AuthoringStage) {
  return stage === "overview" ? "overview" : stage === "writing" ? "writing" : "preparation";
}

// The author-facing direction confirmation uses the existing explicit delegation
// contract, including source/sync checks in the main process. It never approves
// a preview or replaces the review of existing manuscripts.
export function prepareAuthorMessage(text: string, workflow: AuthoringState): string {
  const doc = workflow.documents.overview;
  if (workflow.activeStage !== "overview" || workflow.writingStarted || workflow.reviewGroup?.length ||
      !doc?.content.trim() || doc.needsReview || (doc.sync && doc.sync.status !== "synced")) return text;
  if (!/^(?:继续(?:吧)?|按推荐|就按推荐|确认|确认方向|确认并继续|好的?|可以|就这样)[。！!，,\s]*$/.test(text.trim())) return text;
  return `${text.trim().replace(/[。！!，,\s]+$/, "")}，后面的设定和大纲你来定`;
}

export function continuationBudget(current: number, maximum: number): number {
  return Math.min(maximum, current + 100000);
}

export function budgetStopped(message?: string): boolean {
  return !!message && /预算.*(?:不足|耗尽|用尽|达到)|达到.*调用上限|BUDGET/.test(message);
}

export function authorError(message: string): string {
  if (budgetStopped(message)) return "这是旧版本的预算暂停记录，已有成果和进度仍保留。直接继续即可，无需追加预算。";
  if (/连接失败|NETWORK|401|403|API 密钥|鉴权/.test(message)) return "AI 连接未成功，请检查设置中的 AI 连接，再重试。已有稿件仍保留。";
  return message;
}
