import { z } from "zod";
import { DomainError } from "./validation";
import type { ID, RecordMeta, SourceRevision, TaskUsage } from "./types";
import type { TextSelection } from "./reader";
export interface SceneStoryStamp {
    beforeOrdinal: number;
    writingJobId?: ID;
    digest: string;
}
export interface SceneCardDraft {
    id?: ID;
    revision?: number;
    title: string;
    pov: string;
    goal: string;
    obstacle: string;
    turn: string;
    reveal: string;
    words: number;
    hook: string;
    anchor?: TextSelection;
}
export interface SceneCard extends SceneCardDraft {
    id: ID;
    revision: number;
}
export interface ScenePlan extends RecordMeta {
    projectId: ID;
    chapterId: ID;
    targetWords: number;
    cards: SceneCard[];
    sources: SourceRevision[];
    storyStamp: SceneStoryStamp;
    origin: "manual" | "planning" | "writing";
    history: Omit<ScenePlan, "history">[];
}
export interface SceneJob extends RecordMeta {
    projectId: ID;
    chapterId: ID;
    profileId?: ID;
    basePlanId?: ID;
    basePlanRevision?: number;
    targetWords: number;
    text: string;
    sources: SourceRevision[];
    storyStamp: SceneStoryStamp;
    status: "running" | "paused" | "failed" | "interrupted" | "cancelled" | "completed" | "awaiting-author";
    tokenBudget: number;
    budgetUsed: number;
    calls: number;
    usage: TaskUsage | null;
    reply: string;
    warnings: string[];
}
export interface SceneWorkspace {
    plan?: ScenePlan;
    needsReview: boolean;
    jobs: SceneJob[];
}
export interface SceneSource {
    id: ID;
    revision: number;
    cardId: ID;
    storyStamp?: SceneStoryStamp;
}
export type SceneSave = {
    type: "scene.save";
    projectId: ID;
    chapterId: ID;
    id?: ID;
    revision?: number;
    targetWords: number;
    cards: SceneCardDraft[];
};
export type SceneCommand = SceneSave | {
    type: "scene.restore";
    id: ID;
    revision: number;
    historyRevision: number;
} | {
    type: "scene.plan";
    projectId: ID;
    chapterId: ID;
    text: string;
    tokenBudget: number;
    profileId?: ID;
} | {
    type: "scene.pause" | "scene.cancel";
    id: ID;
} | {
    type: "scene.resume";
    id: ID;
    tokenBudget?: number;
    profileId?: ID;
    text?: string;
} | {
    type: "scene.revise";
    id: ID;
    revision: number;
    cardId: ID;
    text: string;
    tokenBudget: number;
    profileId?: ID;
};
const id = z.string().min(1).max(200), rev = z.number().int().min(1), words = z.number().int().min(1).max(16000), str = z.string().max(400), text = z.string().trim().min(1).max(10000), budget = z.number().int().min(1).max(1000000);
const stamp = z.object({ beforeOrdinal: rev, writingJobId: id.optional(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const source = z.object({ kind: z.enum(["chapter", "project", "note"]), id, revision: rev }).strict();
const selection = z.object({ chapterId: id, revision: rev, start: z.number().int().min(0), end: z.number().int().min(1), quote: z.string().min(1).max(16000) }).strict().refine(s => s.end - s.start === s.quote.length);
const cardShape = { title: z.string().trim().min(1).max(120), pov: str, goal: str, obstacle: str, turn: str, reveal: str, words, hook: str, anchor: selection.optional() };
const draft = z.object({ ...cardShape, id: id.optional(), revision: rev.optional() }).strict();
const card = z.object({ ...cardShape, id, revision: rev }).strict();
const meta = { id, revision: rev, createdAt: z.string().datetime(), updatedAt: z.string().datetime() };
const frame = z.object({ ...meta, projectId: id, chapterId: id, targetWords: words, cards: z.array(card).min(2).max(4), sources: z.array(source).max(1000), storyStamp: stamp, origin: z.enum(["manual", "planning", "writing"]) }).strict();
const plan = frame.extend({ history: z.array(frame).max(50) }).strict();
const usage = z.object({ inputTokens: z.number().int().min(0).nullable(), outputTokens: z.number().int().min(0).nullable(), totalTokens: z.number().int().min(0).nullable(), estimated: z.boolean() }).strict().nullable();
const job = z.object({ ...meta, projectId: id, chapterId: id, profileId: id.optional(), basePlanId: id.optional(), basePlanRevision: rev.optional(), targetWords: words, text, sources: z.array(source).max(1000), storyStamp: stamp, status: z.enum(["running", "paused", "failed", "interrupted", "cancelled", "completed", "awaiting-author"]), tokenBudget: budget, budgetUsed: z.number().int().min(0), calls: z.number().int().min(0), usage, reply: z.string().max(4000), warnings: z.array(z.string().max(1000)).max(100) }).strict();
function check(schema: z.ZodType, value: unknown) { if (!schema.safeParse(value).success)
    throw new DomainError("VALIDATION", "场景卡、来源或任务格式不正确"); }
export function validateSceneCards(value: unknown, target: number): asserts value is SceneCardDraft[] {
    check(z.array(draft).min(2).max(4), value);
    check(words, target);
    const cards = value as SceneCardDraft[];
    if (cards.reduce((n, c) => n + c.words, 0) !== target || new Set(cards.flatMap(c => c.id ? [c.id] : [])).size !== cards.filter(c => c.id).length)
        throw new DomainError("VALIDATION", "场景篇幅合计须等于本章计划字数，场景不能重复");
}
export function validateScenePlan(value: unknown): asserts value is ScenePlan {
    check(plan, value);
    const p = value as ScenePlan;
    for (const f of [p, ...p.history]) {
        validateSceneCards(f.cards, f.targetWords);
        if (f.id !== p.id || f.chapterId !== p.chapterId || f.projectId !== p.projectId || f.revision > p.revision || f.cards.some(c => c.anchor && c.anchor.chapterId !== p.chapterId))
            throw new DomainError("VALIDATION", "场景历史或原文归属不正确");
    }
    if (p.history.some((h, i) => h.revision >= p.revision || i > 0 && h.revision <= p.history[i - 1].revision))
        throw new DomainError("VALIDATION", "场景历史版本顺序不正确");
}
export function validateSceneJob(value: unknown): asserts value is SceneJob { check(job, value); const j = value as SceneJob; if (!!j.basePlanId !== (j.basePlanRevision !== undefined))
    throw new DomainError("VALIDATION", "规划原版本不正确"); }
export function validateSceneSource(value: unknown): asserts value is SceneSource { check(z.object({ id, revision: rev, cardId: id, storyStamp: stamp.optional() }).strict(), value); }
export function validateSceneCommand(value: unknown): asserts value is SceneCommand {
    check(z.discriminatedUnion("type", [
        z.object({ type: z.literal("scene.save"), projectId: id, chapterId: id, id: id.optional(), revision: rev.optional(), targetWords: words, cards: z.array(draft).min(2).max(4) }).strict(),
        z.object({ type: z.literal("scene.restore"), id, revision: rev, historyRevision: rev }).strict(),
        z.object({ type: z.literal("scene.plan"), projectId: id, chapterId: id, text, tokenBudget: budget, profileId: id.optional() }).strict(),
        z.object({ type: z.literal("scene.pause"), id }).strict(), z.object({ type: z.literal("scene.cancel"), id }).strict(),
        z.object({ type: z.literal("scene.resume"), id, tokenBudget: budget.optional(), profileId: id.optional(), text: text.optional() }).strict(),
        z.object({ type: z.literal("scene.revise"), id, revision: rev, cardId: id, text, tokenBudget: budget, profileId: id.optional() }).strict(),
    ]), value);
}

/** Scene revisions retain the original authority even after backup/import. */
export function validateSceneReplacement(selection:TextSelection|undefined,candidate:{chapterId:ID;sourceRevision:number;title:string;baseTitle?:string;baseContent:string;content:string}):void {
  if(!selection||candidate.chapterId!==selection.chapterId||candidate.sourceRevision!==selection.revision||candidate.baseTitle===undefined||candidate.title!==candidate.baseTitle||selection.end>candidate.baseContent.length||candidate.baseContent.slice(selection.start,selection.end)!==selection.quote)
    throw new DomainError("VALIDATION","场景候选的原文范围或标题不正确");
  const prefix=candidate.baseContent.slice(0,selection.start),suffix=candidate.baseContent.slice(selection.end);
  if(candidate.content.length<prefix.length+suffix.length||!candidate.content.startsWith(prefix)||!candidate.content.endsWith(suffix))
    throw new DomainError("VALIDATION","场景候选越过了绑定片段的修改范围");
}
export function validateSceneSelection(plan:ScenePlan,source:SceneSource,selection:TextSelection|undefined,completedHistory=false):void {
  if(plan.id!==source.id||!selection||selection.chapterId!==plan.chapterId)throw new DomainError("VALIDATION","场景卡与实际选段不一致");
  const frames=[plan,...plan.history],frame=frames.find(f=>f.revision===source.revision);
  // Trimmed completed history is read-only: it cannot resume or acquire current authority.
  if(!frame&&completedHistory&&source.revision<Math.min(...frames.map(f=>f.revision)))return;
  const anchor=frame?.cards.find(c=>c.id===source.cardId)?.anchor;
  if(!anchor||(["chapterId","revision","start","end","quote"] as const).some(k=>anchor[k]!==selection[k]))
    throw new DomainError("VALIDATION","场景卡绑定原文与实际选段不一致");
}
