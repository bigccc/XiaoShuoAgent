import type {TextSelection} from "../shared/reader";
import type { RevisionCommand } from "../shared/revision";
import type { SceneSource, SceneCommand } from "../shared/scenes";
import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { DomainError } from "../shared/validation";
import { validateSceneCards, validateSceneCommand, validateScenePlan,validateSceneSelection } from "../shared/scenes";
import type { SceneSave, ScenePlan, SceneCardDraft, SceneWorkspace } from "../shared/scenes";
import type { Chapter, SourceRevision } from "../shared/types";
import { buildContext, sourceCurrent } from "./context";
import { storyContext, storyStampCurrent, type StoryStamp } from "./story-context";
export class SceneService {
    constructor(private store: Store) { }
    chapter(id: string, projectId?: string) { const c = this.store.get("chapters", id); if (!c || projectId && c.projectId !== projectId)
        throw new DomainError("VALIDATION", "场景所属章节不存在或属于其他作品"); const p = this.store.get("projects", c.projectId); if (!p || p.archived)
        throw new DomainError("CONFLICT", "作品不存在或已归档"); return c; }
    record(id: string) { const p = this.store.get("scenePlans", id); if (!p)
        throw new DomainError("NOT_FOUND", "场景计划不存在"); return p; }
    targetWords(chapterId:string,fallback:number){return this.forChapter(chapterId)?.targetWords??fallback;}
    forChapter(chapterId: string) { return this.store.selectByProject("scenePlans", this.chapter(chapterId).projectId).find(p => p.chapterId === chapterId); }
    current(p: ScenePlan) { const state = this.store.snapshot(); return p.sources.every(s => sourceCurrent(state, s)) && storyStampCurrent(state, p.projectId, p.storyStamp) && p.cards.every(c => !c.anchor || this.anchorCurrent(c.anchor, p.chapterId)); }
    private anchorCurrent(a: NonNullable<SceneCardDraft["anchor"]>, chapterId: string) { const c = this.store.get("chapters", chapterId); return !!c && a.chapterId === chapterId && a.revision === c.revision && c.content.slice(a.start, a.end) === a.quote; }
    workspace(chapterId: string): SceneWorkspace { if (typeof chapterId !== "string" || !chapterId)
        throw new DomainError("VALIDATION", "章节编号不正确"); const c = this.chapter(chapterId), p = this.forChapter(c.id); return { ...(p ? { plan: { ...p, history: [] } } : {}), needsReview: !!p && !this.current(p), jobs: this.store.selectByProject("sceneJobs", c.projectId).filter(j => j.chapterId === c.id).slice(-5) }; }
    dependencies(chapter: Chapter) { const state = this.store.snapshot(), built = buildContext(state, chapter.projectId, { includeDraftIds: [chapter.id] }, [chapter.id]); return { sources: [...new Map(built.sources.map(s => [`${s.kind}:${s.id}`, s])).values()], storyStamp: storyContext(state, chapter.projectId, chapter.ordinal).stamp }; }
    save(c: SceneSave, origin: ScenePlan["origin"] = "manual", dependencies?: {
        sources: SourceRevision[];
        storyStamp: StoryStamp;
    }): ScenePlan {
        validateSceneCommand(c);
        validateSceneCards(c.cards, c.targetWords);
        return this.store.transaction(() => {
            const ch = this.chapter(c.chapterId, c.projectId), existing = this.forChapter(ch.id), old = c.id ? this.record(c.id) : undefined;
            if (!!c.id !== (c.revision !== undefined) || old && (old.projectId !== c.projectId || old.chapterId !== ch.id || old.revision !== c.revision) || !old && existing)
                throw new DomainError("CONFLICT", "场景计划已改变，请重新读取当前版本");
            const known = new Map<string, number>();
            for (const f of [...(old?.history ?? []), ...(old ? [old] : [])])
                for (const card of f.cards)
                    known.set(card.id, Math.max(card.revision, known.get(card.id) ?? 0));
            const cards = c.cards.map(card => {
                if (card.id && !known.has(card.id))
                    throw new DomainError("VALIDATION", "场景卡不属于这份计划");
                const previous = old?.cards.find(v => v.id === card.id);
                if (previous && card.revision !== previous.revision)
                    throw new DomainError("CONFLICT", "场景卡已改变，请重新读取");
                if (card.anchor && !this.anchorCurrent(card.anchor, ch.id))
                    throw new DomainError("CONFLICT", "绑定原文已改变，请重新定位具体片段");
                return { ...card, id: card.id ?? randomUUID(), revision: card.id ? (known.get(card.id) ?? 0) + 1 : 1 };
            });
            const now = new Date().toISOString(), { history, ...frame } = old ?? ({ history: [] } as any), dep = dependencies ?? this.dependencies(ch);
            const p: ScenePlan = { id: old?.id ?? randomUUID(), revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now, projectId: ch.projectId, chapterId: ch.id, targetWords: c.targetWords, cards, sources: dep.sources, storyStamp: dep.storyStamp, origin, history: old ? [...history, frame].slice(-50) : [] };
            const serialized: ScenePlan = JSON.parse(JSON.stringify(p));
            validateScenePlan(serialized);
            this.store.put("scenePlans", serialized);
            return serialized;
        });
    }
    restore(id: string, revision: number, historyRevision: number) { const p = this.record(id); if (p.revision !== revision)
        throw new DomainError("CONFLICT", "场景计划已改变"); const h = p.history.find(h => h.revision === historyRevision); if (!h)
        throw new DomainError("NOT_FOUND", "场景历史不存在"); const ch = this.chapter(p.chapterId); const cards = h.cards.map(card => { const current = p.cards.find(v => v.id === card.id); const a = card.anchor; const start = a ? ch.content.indexOf(a.quote) : -1; return { ...card, ...(current ? { revision: current.revision } : {}), anchor: a && start >= 0 && ch.content.indexOf(a.quote, start + 1) < 0 ? { ...a, revision: ch.revision, start, end: start + a.quote.length } : undefined }; }); return this.save({ type: "scene.save", id: p.id, revision: p.revision, projectId: p.projectId, chapterId: p.chapterId, targetWords: h.targetWords, cards }); }
    assertSource(source: SceneSource, projectId: string,selection?:TextSelection) { const p = this.record(source.id); if (p.projectId !== projectId || p.revision !== source.revision || !p.cards.some(c => c.id === source.cardId) || !this.current(p) || source.storyStamp && !storyStampCurrent(this.store.snapshot(), projectId, source.storyStamp))
        throw new DomainError("CONFLICT", "场景计划或故事依据已改变，请重新生成定向候选稿"); validateSceneSelection(p,source,selection);return p; }
    revisionStart(c: Extract<SceneCommand, {
        type: "scene.revise";
    }>): Extract<RevisionCommand, {
        type: "revision.start";
    }> { validateSceneCommand(c); const p = this.record(c.id); if (p.revision !== c.revision || !this.current(p))
        throw new DomainError("CONFLICT", "场景来源已改变，请复核保存后改稿"); const card = p.cards.find(card => card.id === c.cardId); if (!card?.anchor)
        throw new DomainError("VALIDATION", "请先绑定这张场景卡要修改的原文片段"); return { type: "revision.start", projectId: p.projectId, scope: "selection", selection: card.anchor, chapterIds: [p.chapterId], text: c.text, tokenBudget: c.tokenBudget, ...(c.profileId ? { profileId: c.profileId } : {}), sceneSource: { id: p.id, revision: p.revision, cardId: card.id, storyStamp: storyContext(this.store.snapshot(), p.projectId, this.chapter(p.chapterId).ordinal).stamp } }; }
    capture(chapter: Chapter, raw: unknown, targetWords: number): string[] {
        try {
            if (!Array.isArray(raw))
                throw new DomainError("VALIDATION", "场景卡格式不正确");
            const cards = raw.map((value: any) => { if (!value || typeof value !== "object")
                throw new DomainError("VALIDATION", "场景卡格式不正确"); const { quote, ...card } = value; if (quote === undefined)
                return card; if (typeof quote !== "string" || !quote || quote.length > 16000)
                throw new DomainError("VALIDATION", "场景引用格式不正确"); const start = chapter.content.indexOf(quote); return { ...card, ...(start >= 0 && chapter.content.indexOf(quote, start + 1) < 0 ? { anchor: { chapterId: chapter.id, revision: chapter.revision, start, end: start + quote.length, quote } } : {}) }; });
            const old = this.forChapter(chapter.id);
            if (old?.origin !== undefined && old.origin !== "writing")
                return ["作者场景计划已保留，模型附带卡片未覆盖"];
            this.save({ type: "scene.save", projectId: chapter.projectId, chapterId: chapter.id, ...(old ? { id: old.id, revision: old.revision } : {}), targetWords, cards }, "writing");
            return [];
        }
        catch (e) {
            return [e instanceof DomainError ? `${e.message}；场景卡未更新，正文已保留` : "场景卡未更新，正文已保留"];
        }
    }
}
