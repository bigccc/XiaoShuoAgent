import type {
  AuthoringIntent,
  AuthoringStage,
  AuthoringState,
  ConversationResponse,
  PlanningStage,
} from "../shared/types";
import {
  newDocument,
  planningStages,
  stageNames,
  validateAuthoring,
} from "../shared/authoring";
import { DomainError } from "../shared/validation";

const affirmative =
  /^(?:(?:继续(?:吧)?|按推荐|就按推荐|好的?|可以|是的|对|嗯|确认|就这样|没问题|确认并继续|就按这个来|同意|通过)[。！!，,\s]*)+$/;
export function authoringIntent(
  state: AuthoringState,
  text: string,
  requested?: AuthoringStage,
  hasManuscript = false,
): AuthoringIntent {
  const acceptance = affirmative.test(
    text.trim().replace(/^回到规划[，,\s]*/, ""),
  );
  let target: AuthoringStage = requested ?? state.activeStage;
  const order: AuthoringStage[] = [...planningStages, "writing"];
  if (
    order.indexOf(target) > order.indexOf(state.activeStage) &&
    !(target === "writing" && hasManuscript)
  )
    target = state.activeStage;
  const named =
    /(?:改|调整|重写|完善|补齐|聊聊|写|生成).{0,10}?(概要|梗概|设定|大纲)/.exec(
      text,
    );
  if (named)
    target =
      named[1] === "概要" || named[1] === "梗概"
        ? "overview"
        : named[1] === "设定"
          ? "settings"
          : "outline";
  const stageWords = {
    overview: /概要|梗概/,
    settings: /设定/,
    outline: /大纲/,
  };
  const delegatedClauses = text
    .split(/[，。；,;\n]|但是|但/)
    .filter(
      (c) =>
        /你来定|你决定|自动完成|一起完成|全部完成|都完成|连续完成/.test(c) &&
        !/不要|别|暂不|先不|等.*确认|确认后/.test(c),
    );
  const delegated =
    delegatedClauses.length > 0 &&
    /概要|梗概|设定|大纲|规划|后面|前期/.test(text);
  const explicitDelegation = planningStages.filter(
    (s) =>
      delegated &&
      text
        .split(/[，。；,;\n]|但是|但/)
        .some(
          (c) =>
            stageWords[s].test(c) &&
            !/不要|别|暂不|先不|等.*确认|确认后/.test(c),
        ),
  );
  const deferred = planningStages.filter((s) =>
    text
      .split(/[，。；,;\n]|但是|但/)
      .some(
        (c) =>
          stageWords[s].test(c) && /不要|别|暂不|先不|等.*确认|确认后/.test(c),
      ),
  );
  const writing =
    !named &&
    /试写|先写.{0,8}(?:一段|开篇|开头|一章)|直接.{0,5}写|开始.{0,5}(?:写|创作)|(?:继续|完成).{0,6}(?:这一章|本章|开篇|下一章)|(?:连写|连续写|接着写|续写|写).{0,5}[一二两三四五\d]章|(?:重写|改写).{0,8}章|写正文/.test(
      text,
    ) &&
    !/(?:不要|别|先不).{0,5}(?:写|创作)/.test(text);
  const intent: AuthoringIntent = {
    targetStage: target,
    outputStages: [],
    approveStages: [],
    allowWriting: target === "writing",
    preview:
      (writing || target === "writing") && state.activeStage !== "writing",
    delegated,
    reconciliation: false,
  };
  if (writing) {
    intent.allowWriting = true;
    intent.targetStage = "writing";
    intent.outputStages = intent.preview
      ? []
      : planningStages.filter(
          (s) =>
            s === "outline" ||
            !state.documents[s]?.content.trim() ||
            state.documents[s]?.needsReview,
        );
    return intent;
  }
  const forwardDelegation =
    delegated &&
    !named &&
    state.activeStage !== "writing" &&
    (!explicitDelegation.length ||
      Math.min(...explicitDelegation.map((s) => planningStages.indexOf(s))) >
        planningStages.indexOf(state.activeStage));
  if (acceptance || forwardDelegation) {
    // Continue refers to actual progress, never merely to an earlier tab being viewed.
    target = state.activeStage;
    if (target !== "writing") {
      const group = state.reviewGroup?.length ? state.reviewGroup : [target];
      if (
        group.every(
          (s) =>
            state.documents[s]?.content.trim() &&
            !state.documents[s]?.needsReview,
        )
      ) {
        intent.approveStages = [...group];
        const next =
          Math.max(...group.map((s) => planningStages.indexOf(s))) + 1;
        target = state.writingStarted
          ? "writing"
          : (planningStages
              .slice(0, next)
              .find(
                (s) =>
                  !intent.approveStages.includes(s) &&
                  (!state.documents[s]?.approved ||
                    state.documents[s]?.needsReview),
              ) ??
            planningStages[next] ??
            "writing");
      }
    }
  }
  if (delegated) {
    // A planning delegation never grants prose permission or accepts the planning
    // document the author has explicitly asked us to rewrite.
    if (!forwardDelegation || target === "writing")
      target =
        explicitDelegation[0] ??
        (state.activeStage === "writing" ? "outline" : state.activeStage);
    intent.approveStages = intent.approveStages.filter((s) => s !== target);
  }
  intent.targetStage = target;
  intent.allowWriting = target === "writing";
  intent.preview =
    target === "writing" &&
    state.activeStage !== "writing" &&
    !intent.approveStages.length;
  if (target === "writing") {
    intent.outputStages = intent.preview
      ? []
      : planningStages.filter(
          (s) =>
            s === "outline" ||
            !state.documents[s]?.content.trim() ||
            state.documents[s]?.needsReview,
        );
    return intent;
  }
  const index = planningStages.indexOf(target);
  const downstream = planningStages.slice(index + 1);
  intent.reconciliation =
    downstream.some((s) => !!state.documents[s]?.content.trim()) &&
    (!acceptance ||
      downstream.some((s) => state.documents[s]?.needsReview) ||
      !!state.documents[target]?.needsReview);
  const end = explicitDelegation.length
    ? Math.max(...explicitDelegation.map((s) => planningStages.indexOf(s)))
    : 2;
  intent.outputStages = delegated
    ? planningStages
        .slice(index, Math.max(index, end) + 1)
        .filter((s) => !deferred.includes(s))
    : intent.reconciliation
      ? [...planningStages.slice(index)]
      : [target];
  if (delegated && intent.reconciliation)
    intent.outputStages = planningStages.filter(
      (s) =>
        intent.outputStages.includes(s) ||
        (downstream.includes(s) &&
          !!state.documents[s] &&
          !deferred.includes(s)),
    );
  if (deferred.some((s) => downstream.includes(s) && !!state.documents[s]))
    intent.reconciliation = false;
  return intent;
}
export function writeDocument(
  state: AuthoringState,
  stage: PlanningStage,
  content: string,
): boolean {
  const old = state.documents[stage];
  if (old?.content === content && !old.needsReview) return false;
  state.documents[stage] = old
    ? {
        ...old,
        content,
        revision: old.revision + 1,
        approved: false,
        needsReview: false,
        history:
          old.content !== content
            ? [
                ...old.history,
                {
                  content: old.content,
                  revision: old.revision,
                  createdAt: new Date().toISOString(),
                  ...(old.sync?.batchId &&
                  old.sync.status === "synced" &&
                  old.content === old.sync.lastSyncedContent
                    ? { batchId: old.sync.batchId }
                    : {}),
                },
              ]
            : old.history,
      }
    : newDocument(content);
  if (old?.sync)
    state.documents[stage]!.sync = {
      ...old.sync,
      status: old.sync.status === "conflict" ? "conflict" : "pending",
    };
  for (const next of planningStages.slice(planningStages.indexOf(stage) + 1)) {
    const doc = state.documents[next];
    if (doc)
      state.documents[next] = { ...doc, approved: false, needsReview: true };
  }
  delete state.reviewGroup;
  return true;
}
export function applyAuthoring(
  before: AuthoringState,
  intent: AuthoringIntent,
  response: ConversationResponse,
): AuthoringState {
  const next = structuredClone(before);
  const artifacts = response.artifacts ?? [];
  if (response.chapters?.length && !intent.allowWriting)
    throw new DomainError(
      "VALIDATION",
      "当前仍在准备创作方案，模型不能自行跳到正文；你可以明确要求先试写",
    );
  if (
    artifacts.some((a) => !intent.outputStages.includes(a.stage)) ||
    new Set(artifacts.map((a) => a.stage)).size !== artifacts.length
  )
    throw new DomainError(
      "VALIDATION",
      "模型返回了当前阶段之外或重复的成果，请重试",
    );
  if (
    intent.delegated &&
    intent.outputStages.some((s) => !artifacts.some((a) => a.stage === s))
  )
    throw new DomainError(
      "VALIDATION",
      "模型未完整返回本轮委托的规划成果，请重试；原成果仍保留",
    );
  for (const stage of intent.approveStages) {
    const doc = next.documents[stage];
    if (!doc?.content.trim() || doc.needsReview)
      throw new DomainError("CONFLICT", "阶段成果已变化，请先查看当前内容");
    doc.approved = true;
  }
  if (intent.approveStages.length) delete next.reviewGroup;
  const changed: PlanningStage[] = [];
  for (const stage of planningStages) {
    const artifact = artifacts.find((a) => a.stage === stage);
    // Preflight also receives structured blocks before StageSync materializes
    // their headings and bindings. Their source text must form temporary
    // documents so delegated review groups can be validated. Only the later
    // normalized, version-checked result is committed to the work.
    const content = artifact?.content ?? artifact?.blocks?.map(b => b.text ?? "").join("\n\n");
    if (
      artifact &&
      content !== undefined &&
      writeDocument(next, stage, content)
    )
      changed.push(stage);
  }
  if (intent.reconciliation && changed.length) {
    const stale = planningStages.filter((s) => next.documents[s]?.needsReview);
    if (stale.length)
      throw new DomainError(
        "VALIDATION",
        "上游修改尚未同步相关设定和大纲，请重新尝试；原成果已保留",
      );
    next.reviewGroup = [...changed];
  }
  if (!intent.preview)
    next.activeStage =
      intent.delegated && artifacts.length
        ? artifacts.reduce((a, b) =>
            planningStages.indexOf(a.stage) > planningStages.indexOf(b.stage)
              ? a
              : b,
          ).stage
        : intent.targetStage;
  if (intent.delegated && artifacts.length)
    next.reviewGroup = planningStages.filter((s) =>
      artifacts.some((a) => a.stage === s),
    );
  if (next.activeStage === "writing" && !intent.preview)
    next.writingStarted = true;
  validateAuthoring(next);
  return next;
}
export function authoringInstruction(
  state: AuthoringState,
  intent: AuthoringIntent,
): string {
  const examples = {
    overview: [
      { kind: "field", field: "title", text: "书名" },
      { kind: "field", field: "genre", text: "题材" },
      { kind: "field", field: "background", text: "完整概要与背景" },
    ],
    settings: [
      { kind: "field", field: "style", text: "文风" },
      { kind: "field", field: "pace", text: "节奏" },
      {
        kind: "note",
        noteType: "character",
        title: "主角",
        text: "人物动机与关系",
      },
      { kind: "note", noteType: "world", title: "世界规则", text: "世界规则" },
      {
        kind: "note",
        noteType: "location",
        title: "主要地点",
        text: "地点设定",
      },
    ],
    outline: [
      {
        kind: "note",
        noteType: "storyline",
        title: "主线与支线",
        text: "完整主支线",
      },
      {
        kind: "note",
        noteType: "outline",
        title: "全书大纲",
        text: "全书及分卷结构",
      },
      {
        kind: "note",
        noteType: "chapterOutline",
        title: "近期章纲",
        text: "近期三至五章",
      },
    ],
  };
  const contract =
    intent.outputStages.length && !intent.allowWriting
      ? `本轮只返回message、suggestions、memory、artifacts；不要另外返回project、notes或chapters。artifacts必须仅包含本轮允许的阶段。settings严禁title/genre/background字段；outline严禁任何field块。不要重写未授权的上游概要。按以下本轮JSON形状替换示例文字为完整内容：${JSON.stringify({ message: "阶段已准备", artifacts: intent.outputStages.map((stage) => ({ stage, blocks: examples[stage] })) })}。已有记录必须用上下文中的真实noteId；新增记录省略noteId，禁止自造ID。`
      : "";
  return `本轮流程由应用决定：当前任务为${stageNames[intent.targetStage]}；允许返回的阶段成果：${intent.outputStages.map((s) => stageNames[s]).join("、") || "无"}；${intent.allowWriting ? (intent.preview ? "作者明确要求提前试写，可以写正文，但保留原规划阶段，不要声称规划已完成。" : "可以创作正文。旧作品缺失的规划可根据已有正文补齐，不要求重走流程。") : "不得返回chapters。"}
${intent.delegated ? "作者已委托连续完成这些规划阶段，请全部准备好后集中展示。" : "默认每阶段一次整体确认，提出推荐，不要逐项询问常规字段。"}
${intent.reconciliation ? "这是上游调整，请同步受影响的设定和未写大纲，一次返回完整相关成果并在message解释影响；已有正文保持原样，除非作者明确要求回改。" : ""}
${intent.outputStages.length ? '阶段成果必须通过artifacts结构化块一次返回，例如[{"stage":"settings","blocks":[{"kind":"field","field":"style","text":"文风"},{"kind":"note","noteId":"已有角色的id，新增则省略","noteType":"character","title":"名字","text":"完整人物设定"}]}]。overview字段title/genre/background；settings字段style/pace与character/world/location；outline记录storyline/outline/chapterOutline。其他内容用supplement完整保留。每个块包含完整正文；改名用原noteId。明确删除当前关联记录时用removeNoteIds，删除字段用removeFields。不得仅返回一整段content或另外一套可选notes来代替结构化成果，确认状态由应用维护。' : ''}
最新阶段成果中的作者修改优先于旧的推导笔记；遇到与已写正文冲突，说明影响，不自行回改。更新阶段成果时也同步相关的已有设定记录，避免两套资料互相矛盾。
概要应包含冲突、成长、关键转折和结局方向，可以剧透；设定应包含必要人物关系、世界规则、背景与基调；大纲应包含全书主线、重要转折和近期3—5章章纲。首次规划请主动给完整推荐方案，避免仅提出大量问题。确认状态由作者和应用维护，不得自行返回approved。${state.reviewGroup?.length ? "待作者集中确认的成果：" + state.reviewGroup.map((s) => stageNames[s]).join("、") : ""}
${contract}`;
}
