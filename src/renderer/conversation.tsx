import { GenerationPreviews } from "./generation-preview";
import { Modal } from "./modal";
import { ContextReferences } from "./context-references";
import { useEffect, useRef, useState } from "react";
import type { AppState, AuthoringStage, ConversationTurn } from "../shared/types";
import type { Run } from "./api";
import type { Flush, Register } from "./editing";
import { Reader, type RevisionRequest } from "./reader";
import { Revisions } from "./revisions";
import { ConversationRecovery } from "./conversation-recovery";
import { WritingProgress } from "./writing-progress";
import { ChapterEditor } from "./chapters";
import { Field, noteNames } from "./ui";
import { NoteHistory } from "./note-history";
import {
  authoringStages,
  readAuthoring,
  stageNames,
} from "../shared/authoring";
import { StageEditor } from "./authoring";
import { fieldLabels } from "../shared/sync";
import { authorStep, prepareAuthorMessage, authorError } from "./author-experience";

function readLocal(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function saveLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The current composer remains editable. */
  }
}

function ThinkingStatus({ turn }: { turn: ConversationTurn }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(
    0,
    Math.round((now - new Date(turn.createdAt).getTime()) / 1000),
  );
  return (
    <div className="thinking" role="status">
      {turn.recoveryPhase === "retrying"
        ? "正在重新获取回复…"
        : turn.recoveryPhase === "repairing"
          ? "正在整理回复格式，保留已生成的内容…"
          : "正在构思和写作…完成后会自动保存到右侧。"}
      {elapsed >= 3 && (
        <small>
          已等待{" "}
          {elapsed >= 60
            ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
            : `${elapsed} 秒`}
        </small>
      )}
    </div>
  );
}

export function Conversation({
  state,
  projectId,
  run,
  flush,
  register,
  refresh,
  showProfiles,
  showNotes,
  showStoryState,
  pendingCount,
  showTasks,
  showFiles,
  revisionRequest,
  clearRevisionRequest,
}: {
  state: AppState;
  projectId: string;
  run: Run;
  flush: Flush;
  register: Register;
  refresh: () => Promise<void>;
  showProfiles: () => void;
  showNotes: () => void;
  showStoryState: () => void;
  pendingCount: number;
  showTasks: () => void;
  showFiles: () => void;
  revisionRequest?: RevisionRequest;
  clearRevisionRequest: () => void;
}) {
  const draftKey = `conversation-draft:${projectId}`,
    chapterKey = `conversation-chapter:${projectId}`;
  const project = state.projects.find((p) => p.id === projectId)!;
  const workflow = readAuthoring(state, project);
  const viewKey = `authoring-view:${projectId}`;
  const [viewStage, setViewStage] = useState<AuthoringStage>(() => {
    const saved = readLocal(viewKey) as AuthoringStage;
    return authoringStages.includes(saved) ? saved : workflow.activeStage;
  });
  function showStage(stage: AuthoringStage) {
    setViewStage(stage);
    saveLocal(viewKey, stage);
    setShowData(false);
  }
  const turns = state.conversations.filter((t) => t.projectId === projectId);
  const writingJobs = (state.writingJobs ?? []).filter((job) => job.projectId === projectId);
  const last = turns.at(-1);
  const chapters = state.chapters
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const notes = state.notes.filter(
    (n) => n.projectId === projectId && !n.archived,
  );
  const [paneRequest, setPaneRequest] = useState<RevisionRequest>();
  const requestTarget = paneRequest ?? revisionRequest;
  const [readingPane, setReadingPane] = useState(false);
  const [revisionScope, setRevisionScope] = useState<
    "" | "chapter" | "chapters" | "all"
  >("");
  const [mobilePane, setMobilePane] = useState<"chat" | "manuscript">("chat");
  const [startMode, setStartMode] = useState<"idea" | "inspiration">();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [genre, setGenre] = useState("玄幻");
  const [chapterCount, setChapterCount] = useState(1);
  const [writingRequirements, setWritingRequirements] = useState("");
  const [writingError,setWritingError]=useState("");
  const [chapterWords, setChapterWords] = useState(project.chapterWords || 3000);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [rangeStart, setRangeStart] = useState(1),
    [rangeEnd, setRangeEnd] = useState(1);
  const [text, setText] = useState(() => readLocal(draftKey));
  const [selected, setSelected] = useState(() => readLocal(chapterKey));
  const [profileId, setProfileId] = useState("");
  const [sending, setSending] = useState(false),
    [showData, setShowData] = useState(false);
  const log = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const observed = useRef(last?.status === "completed" ? last.id : "");
  const chapter = chapters.find((c) => c.id === selected) ?? chapters.at(-1);
  const active = turns.find((t) => t.status === "running");
  const activeWriting = writingJobs.find((job) => job.status === "running");
  const busy = sending || !!active || !!activeWriting;
  const preferredId =
    profileId ||
    [...turns]
      .reverse()
      .find((t) => state.profiles.some((p) => p.id === t.profileId))?.profileId;
  const model =
    state.profiles.find((p) => p.id === preferredId) ??
    state.profiles.find((p) => p.purpose === "writing") ??
    state.profiles[0];
  useEffect(() => {
    if (stick.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [last?.id, last?.revision, writingJobs.at(-1)?.revision, sending]);
  useEffect(() => {
    if (last?.status !== "completed" || observed.current === last.id) return;
    observed.current = last.id;
    void flush().then((ok) => {
      if (ok) {
        const id = last.chapterIds.at(-1);
        if (id) {
          setSelected(id);
          saveLocal(chapterKey, id);
          showStage("writing");
        } else if (
          last.response?.artifacts?.length ||
          last.authoringIntent?.approveStages.length
        )
          showStage(workflow.activeStage);
      }
    });
  }, [last?.id, last?.status]);
  useEffect(() => {
    if (revisionRequest) {
      const first = revisionRequest.chapterIds[0];
      if (first) {
        setSelected(first);
        saveLocal(chapterKey, first);
      }
      editMessage(
        revisionRequest.text ??
          (revisionRequest.selection
            ? "请修改这段文字："
            : "请根据所选批注修改相关章节："),
      );
      showStage("writing");
    }
  }, [revisionRequest]);
  function editMessage(value: string) {
    setText(value);
    saveLocal(draftKey, value);
  }
  async function send(message = text, proposalTurnId?: string) {
    if (busy || !message.trim() || !model) return;
    setSending(true);
    stick.current = true;
    try {
      if (!(await flush())) return;
      await run({
        type: "conversation.send",
        projectId,
        text: prepareAuthorMessage(message, workflow),
        profileId: model.id,
        stage: viewStage,
        ...(chapter ? { chapterId: chapter.id } : {}),
        ...(proposalTurnId ? { proposalTurnId } : {}),
        ...(requestTarget && !requestTarget.proposalOnly
          ? {
              revisionScope: requestTarget.scope,
              revisionChapterIds: requestTarget.chapterIds,
              selection: requestTarget.selection,
              annotationIds: requestTarget.annotationIds,
            }
          : revisionScope && !requestTarget?.proposalOnly
            ? {
                revisionScope,
                revisionChapterIds:
                  revisionScope === "all"
                    ? chapters.map((c) => c.id)
                    : revisionScope === "chapter"
                      ? chapter
                        ? [chapter.id]
                        : []
                      : chapters
                          .filter(
                            (c) =>
                              c.ordinal >= rangeStart && c.ordinal <= rangeEnd,
                          )
                          .map((c) => c.id),
              }
            : {}),
      });
      editMessage("");
      clearRevisionRequest();
      setPaneRequest(undefined);
      setRevisionScope("");
    } finally {
      setSending(false);
    }
  }
  return (
    <section className={`conversation-workspace mobile-pane-${mobilePane}`} aria-label="对话创作工作区">
      <div className="mobile-pane-switch" role="group" aria-label="创作视图">
        <button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}>聊天</button>
        <button className={mobilePane === "manuscript" ? "active" : ""} onClick={() => setMobilePane("manuscript")}>稿件</button>
      </div>
      <div className="conversation-pane">
        <header className="conversation-heading">
          <div>
            <div className="eyebrow">想法在这里，慢慢长成故事</div>
            <h1>和 AI 一起写故事</h1>
            <p>
              当前：{authorStep(workflow.activeStage) === "overview" ? "定故事" : authorStep(workflow.activeStage) === "preparation" ? "做准备" : "开始写"} ·{" "}
              {workflow.activeStage === "writing"
                ? "逐章推进故事"
                : "AI 准备方案，你来判断方向"}
            </p>
          </div>
          <div className="heading-actions">
            <button onClick={showTasks}>待处理{pendingCount ? ` · ${pendingCount}` : ""}</button>
            <button className="subtle" onClick={showFiles}>导出</button>
            <button className="subtle" onClick={() => setDiagnosticsOpen(true)}>诊断</button>
          </div>
        </header>
        {diagnosticsOpen && (
          <Modal label="对话诊断" wide onClose={() => setDiagnosticsOpen(false)}>
              <div className="page-heading">
                <h2>对话诊断</h2>
                <button className="subtle" aria-label="关闭诊断" onClick={() => setDiagnosticsOpen(false)}>×</button>
              </div>
              <p className="muted">每轮请求的用量与原始回复记录，仅用于排查问题，不影响正文。</p>
              {turns
                .map((t, i) => ({ turn: t, index: i }))
                .filter(({ turn: t }) => (t.usage?.totalTokens != null) || !!t.attempts?.length || ["failed", "cancelled", "interrupted"].includes(t.status))
                .map(({ turn: t, index }) => (
                  <section key={t.id} className="diagnostics-turn">
                    <h3>第 {index + 1} 轮 · {t.text.slice(0, 18) || "（无文字）"}{t.text.length > 18 ? "…" : ""}</h3>
                    {(t.usage?.totalTokens != null || !!t.attempts?.length) && (
                      <div className="diagnostics-usage">
                        <span>{t.usage?.totalTokens == null ? "模型未报告用量" : `${t.usage.totalTokens.toLocaleString()} Token`}</span>
                        {!!t.attempts?.length && <p>本轮共 {t.attempts.length} 次请求，包含自动恢复。</p>}
                        {t.attempts?.some(a => a.usage?.totalTokens == null) && <p>部分请求未返回用量，以上仅为已记录用量。</p>}
                      </div>
                    )}
                    <ConversationRecovery turn={t} />
                  </section>
                ))}
          </Modal>
        )}
        <div
          className="conversation-log"
          ref={log}
          role="log"
          aria-label="创作对话记录"
          onScroll={() => {
            const el = log.current!;
            stick.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          }}
        >
          {!turns.length && !writingJobs.length && (
            <div className="conversation-welcome">
              <div className="welcome-mark">✦</div>
              <h2>
                {chapters.length ? "从现在的故事接着写" : "不必先想好整本书"}
              </h2>
              <p>
                {chapters.length
                  ? `已有 ${chapters.length} 章正文、${notes.length} 份资料。你可以继续写，也可以聊聊想调整的地方。`
                  : "一句灵感、一种感觉都可以。人物、设定和规划会随着创作逐步整理。"}
              </p>
              <div className="starter-list">
                {chapters.length ? ["帮我梳理当前故事，推荐下一步", "继续下一章", "聊聊当前这一章可以怎样改进"].map(s => <button key={s} onClick={() => { editMessage(s); composer.current?.focus(); }}>{s}</button>) : <>
                  <button aria-label="我有一个想法" onClick={() => { setStartMode("idea"); composer.current?.focus(); }}>我有一个想法<span>说一句也可以</span></button>
                  <button aria-label="帮我找个灵感" onClick={() => setStartMode("inspiration")}>帮我找个灵感<span>一起挑一个想写的方向</span></button>
                </>}
              </div>
              {startMode === "idea" && <p>说说主角、一个场景，或者你想写的感觉。还没想好的部分，我们一起补齐。</p>}
              {startMode === "inspiration" && <div className="inspiration-picker">
                <Field label="喜欢的题材"><select value={genre} onChange={e => setGenre(e.target.value)}>{["玄幻", "都市", "仙侠", "悬疑", "言情", "科幻", "历史", "暂时没想好"].map(g => <option key={g}>{g}</option>)}</select></Field>
                <button disabled={busy || !model} onClick={() => void send(`我想写${genre === "暂时没想好" ? "一部网文，还没选定题材" : `一部${genre}网文`}，请推荐三个不同的故事方向，简要说说主角、冲突和看点，让我选一个后再准备完整故事。`).catch(() => {})}>推荐几个方向</button>
              </div>}

            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="conversation-exchange">
              <div className="chat-message author-message">
                <small>你</small>
                <div>{t.text}</div>
              </div>
              <div className="chat-message assistant-message">
                <small>创作搭档</small>
                {t.status === "running" ? (
                  <ThinkingStatus turn={t} />
                ) : (
                  <div>{t.reply || (t.error ? authorError(t.error) : "本轮尚未完成")}</div>
                )}
                {t.reply && t.error && <p className="error">{authorError(t.error)}</p>}
                {t.status === "completed" && t.chapterIds.length > 0 && (
                  <div className="chat-saved">
                    ✓ 正文已自动保存 · 可以直接编辑或查看历史
                  </div>
                )}
                {t.status === "completed" && !!t.response?.notes?.length && (
                  <div className="chat-saved">
                    ✓ 已整理 {t.response.notes.length} 份创作资料
                  </div>
                )}
                {t.contextWarnings.length > 0 && (
                  <details className="chat-details">
                    <summary>本轮阅读范围提醒</summary>
                    {t.contextWarnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </details>
                )}
                <ContextReferences references={t.contextReferences} chapters={state.chapters} />
                {t.status === "failed" && t.response && (
                  <details className="chat-details">
                    <summary>查看尚未应用的回复</summary>
                    <p>{t.response.message}</p>
                    {t.response.artifacts?.map((a, i) => (
                      <div key={a.stage + i}>
                        <h3>{stageNames[a.stage]}</h3>
                        <pre>
                          {a.content ??
                            a.blocks
                              ?.map(
                                (b) =>
                                  `${b.title ?? (b.field ? fieldLabels[b.field] : "")}\n${b.text ?? ""}`,
                              )
                              .join("\n\n")}
                        </pre>
                        <p>
                          {state.syncJobs
                            .filter(
                              (j) =>
                                j.projectId === projectId &&
                                j.stage === a.stage,
                            )
                            .at(-1)?.error ?? "成果仍保留，请处理同步后继续。"}
                        </p>
                      </div>
                    ))}
                    {t.response.chapters?.map((c, i) => (
                      <div key={i}>
                        <h3>{c.title}</h3>
                        <pre>{c.content}</pre>
                      </div>
                    ))}
                  </details>
                )}
                {last?.id === t.id &&
                  ["failed", "cancelled", "interrupted"].includes(t.status) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void flush()
                          .then(async (ok) => {
                            if (ok)
                              await run({
                                type: "conversation.retry",
                                id: t.id,
                              });
                          })
                          .catch(() => {})
                      }
                    >
                      重新尝试
                    </button>
                  )}
              </div>
            </div>
          ))}
          <GenerationPreviews projectId={projectId} refresh={refresh} />
          {writingJobs.map((job) => (
            <WritingProgress key={job.id} job={job} state={state} run={run} flush={flush}
              openStoryState={showStoryState}
              openProfiles={showProfiles}
              otherBusy={sending || !!active || (!!activeWriting && activeWriting.id !== job.id)}
              openChapter={(id) => void flush().then((ok) => {
                if (ok) { setSelected(id); saveLocal(chapterKey, id); showStage("writing"); }
              }).catch(() => {})} />
          ))}
          {writingJobs.length > 0 && <Revisions state={state} projectId={projectId} run={run} excludeJobIds={writingJobs.flatMap(j => j.revisionJobIds)} />}
        </div>
        {!writingJobs.length && <Revisions state={state} projectId={projectId} run={run} excludeJobIds={writingJobs.flatMap(j => j.revisionJobIds)} />}
        <div className="conversation-compose">
          {requestTarget && (
            <div className="revision-target">
              <strong>
                {requestTarget.selection
                  ? `选段 ${requestTarget.selection.end - requestTarget.selection.start} 字`
                  : requestTarget.proposalOnly
                    ? "分卷建议 · 待手动确认"
                    : `${requestTarget.chapterIds.length} 章 · ${requestTarget.annotationIds?.length ?? 0} 条批注`}
              </strong>
              {requestTarget.selection && (
                <blockquote>{requestTarget.selection.quote}</blockquote>
              )}
              <button
                onClick={() => {
                  clearRevisionRequest();
                  setPaneRequest(undefined);
                }}
              >
                清除改稿目标
              </button>
            </div>
          )}
          <details className="revision-scope-controls">
            <summary>选择改稿范围</summary>
            <label>
              改稿范围
              <select
                aria-label="改稿范围"
                value={revisionScope}
                disabled={!!requestTarget}
                onChange={(e) =>
                  setRevisionScope(e.target.value as typeof revisionScope)
                }
              >
                <option value="">普通创作对话</option>
                <option value="chapter">当前章改稿</option>
                <option value="chapters">多章待审稿</option>
                <option value="all">全书联动检查与改稿</option>
              </select>
            </label>
            {revisionScope === "chapters" && (
              <div className="toolbar">
                <input
                  aria-label="改稿起始章"
                  type="number"
                  min={1}
                  value={rangeStart}
                  onChange={(e) => setRangeStart(Number(e.target.value))}
                />
                <input
                  aria-label="改稿结束章"
                  type="number"
                  min={rangeStart}
                  value={rangeEnd}
                  onChange={(e) => setRangeEnd(Number(e.target.value))}
                />
              </div>
            )}
            <small>选段与单章保留历史，多章改稿先生成待审稿。</small>
          </details>
          {last &&
            !busy &&
            ["completed", "awaiting-author"].includes(last.status) && (
              <div className="chat-suggestions">
                {last.suggestions.map((s, i) => (
                  <button
                    key={i}
                    disabled={!model}
                    onClick={() =>
                      void send(
                        s,
                        last.status === "awaiting-author" && i === 0
                          ? last.id
                          : undefined,
                      ).catch(() => {})
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          {writingError && <p className="error" role="alert">{writingError}</p>}
          {!busy && model && <div className="author-next-actions">
            {workflow.activeStage === "overview" && workflow.documents.overview?.content.trim() && !workflow.documents.overview.needsReview && <button onClick={() => void send("按推荐").catch(() => {})}>确认方向，做准备</button>}
            {authorStep(workflow.activeStage) === "preparation" && <button onClick={() => void send("按推荐").catch(() => {})}>按推荐继续</button>}
            {workflow.activeStage !== "writing" && <button onClick={() => void send("先写一段看看").catch(() => {})}>先写一段看看</button>}
            {workflow.activeStage === "writing" && chapter && <button onClick={() => void (async () => {
              if (busy || !(await flush())) return;
              setSending(true); setWritingError("");
              try { await run({type:"writing.start",projectId,profileId:model.id,reviewOnly:true,
                goal:{kind:"append",startOrdinal:chapter.ordinal,endOrdinal:chapter.ordinal},
                text:`检查并修正第${chapter.ordinal}章。保留作者的创作方向与篇幅，明确错误先给出修改预览。`}); }
              finally {setSending(false);}
            })().catch(e => setWritingError(e instanceof Error?e.message:"检查未能开始"))}>检查并修正本章</button>}
            {workflow.activeStage === "writing" && <details className="chapter-actions"><summary>写下一章 / 连续写作</summary>
              <p className="muted">自动写作、检查并修正，完成后直接阅读。字数允许上下浮动 10%。</p>
              <Field label="一次写几章"><input type="number" min={1} max={100} value={chapterCount} onChange={e => setChapterCount(Number(e.target.value))} /></Field>
              <Field label="每章大约多少字"><input type="number" min={1} max={16000} value={chapterWords} onChange={e => setChapterWords(Number(e.target.value))} /></Field>
              <Field label="额外要求（可选）"><textarea maxLength={4000} value={writingRequirements} placeholder="例如：本批揭开一个线索，保持悬念" onChange={e => setWritingRequirements(e.target.value)} /></Field>
              <button className="primary" disabled={busy || !Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 100 || !Number.isInteger(chapterWords) || chapterWords < 1 || chapterWords > 16000} onClick={() => void (async () => {
                if (busy || !(await flush())) return;
                setSending(true); setWritingError("");
                try {
                  const snapshot = await window.novel.snapshot();
                  const ordinal = Math.max(0, ...snapshot.chapters.filter(c => c.projectId === projectId).map(c => c.ordinal)) + 1;
                  await run({type:"writing.start",projectId,profileId:model.id,targetWords:chapterWords,
                    goal:{kind:"append",startOrdinal:ordinal,endOrdinal:ordinal+chapterCount-1},
                    text:`接着写${chapterCount}章，每章大约${chapterWords}字${writingRequirements.trim()?`。额外要求：${writingRequirements.trim()}`:""}`});
                } finally {setSending(false);}
              })().catch(e => setWritingError(e instanceof Error?e.message:"写作未能开始"))}>开始写作</button>
            </details>}
          </div>}
          {!model && (
            <div className="model-nudge">
              <span>连接你使用的 AI 服务，就能一起准备故事。</span>
              <button onClick={showProfiles}>连接 AI</button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send().catch(() => {});
            }}
          >
            <textarea
              ref={composer}
              aria-label="创作消息"
              placeholder="说说你的想法，也可以说「按推荐」「先写一段看看」…"
              maxLength={10000}
              value={text}
              onChange={(e) => editMessage(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.metaKey || e.ctrlKey) &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send().catch(() => {});
                }
              }}
            />
            <div className="composer-actions">
              <details className="model-choice">
                <summary>高级设置</summary>
                <Field label="创作模型">
                  <select
                    value={model?.id ?? ""}
                    disabled={busy}
                    onChange={(e) => setProfileId(e.target.value)}
                  >
                    {state.profiles.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name} · {p.model}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="button" onClick={showProfiles}>
                  管理 AI 连接
                </button>
              </details>
              <div>
                {active ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run({
                        type: "conversation.cancel",
                        id: active.id,
                      }).catch(() => {})
                    }
                  >
                    停止本轮
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || !model || !text.trim()}
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </form>
          <small className="compose-hint">
            ⌘ / Ctrl + Enter 发送 · 正文与对话保存在本机
          </small>
        </div>
      </div>
      <div className="manuscript-pane">
        <nav className="authoring-progress" aria-label="创作阶段">
          {(["overview", "preparation", "writing"] as const).map((step, index) => {
            const stages: AuthoringStage[] = step === "overview" ? ["overview"] : step === "preparation" ? ["settings", "outline"] : ["writing"];
            const target = step === "preparation" ? (authorStep(workflow.activeStage) === "preparation" ? workflow.activeStage : workflow.documents.outline ? "outline" : "settings") : step;
            const approved = step !== "writing" && stages.every(s => s !== "writing" && workflow.documents[s]?.approved);
            return <button key={step} aria-label={["定故事", "做准备", "开始写"][index]} aria-current={authorStep(workflow.activeStage) === step ? "step" : undefined}
              className={authorStep(viewStage) === step && !showData ? "selected" : ""}
              onClick={() => void flush().then(ok => ok && showStage(target))}>
              <span className="stage-number">{approved ? "✓" : index + 1}</span><span>{["定故事", "做准备", "开始写"][index]}<small>{approved ? "已确认" : authorStep(workflow.activeStage) === step ? "进行中" : "随时查看"}</small></span>
            </button>;
          })}
        </nav>
        <details className="stage-documents"><summary>查看具体成果</summary><div className="stage-subtabs" aria-label="查看阶段成果">
          {authoringStages.map(stage => <button key={stage} className={viewStage === stage && !showData ? "active" : ""} onClick={() => void flush().then(ok => ok && showStage(stage))}>{stageNames[stage]}</button>)}
        </div></details>
        <header className="manuscript-heading">
          <div className="manuscript-tabs">
            <span className="current-stage-label">
              {showData ? "资料" : stageNames[viewStage]}
            </span>
            {viewStage === "writing" && (
              <button
                onClick={() =>
                  void flush().then((ok) => ok && setReadingPane(!readingPane))
                }
              >
                {readingPane ? "编辑正文" : "阅读正文"}
              </button>
            )}
            <button
              className={showData ? "active" : ""}
              onClick={() => void flush().then((ok) => ok && setShowData(true))}
            >
              创作资料{notes.length ? ` · ${notes.length}` : ""}
            </button>
          </div>
          {!showData && viewStage === "writing" && chapters.length > 0 && (
            <select
              aria-label="当前章节"
              value={chapter?.id ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                void flush().then((ok) => {
                  if (ok) {
                    setSelected(id);
                    saveLocal(chapterKey, id);
                  }
                });
              }}
            >
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  第{c.ordinal}章 · {c.title}
                  {c.writingStage === "opening" ? "（试写）" : ""}
                </option>
              ))}
            </select>
          )}
        </header>
        {viewStage === "writing" &&
          workflow.activeStage !== "writing" &&
          !showData && (
            <div className="preview-progress">
              当前是提前试写，规划仍停留在{stageNames[workflow.activeStage]}。
              <button
                onClick={() =>
                  void flush().then((ok) => {
                    if (ok) showStage(workflow.activeStage);
                  })
                }
              >
                返回{stageNames[workflow.activeStage]}
              </button>
            </div>
          )}
        {!!workflow.reviewGroup?.length &&
          !showData &&
          viewStage !== "writing" && (
            <div className="stage-review-group">
              本轮集中确认：
              {workflow.reviewGroup.map((s) => stageNames[s]).join("、")}
              。查看后回复「继续」即可。
            </div>
          )}
        <div className="manuscript-scroll">
          {showData ? (
            <div className="conversation-notes">
              <h2>随故事一起生长的资料</h2>
              <p>AI 会整理人物、世界和故事规划，你也可以随时修改。</p>
              <button onClick={showNotes}>编辑创作资料</button>
              {notes.map((n) => (
                <article className="card" key={n.id}>
                  <small>
                    {noteNames[n.type]}
                    {n.needsReview ? " · 待复核" : ""}
                  </small>
                  <h3>{n.title}</h3>
                  <pre>{n.body}</pre>
                  <NoteHistory note={n} run={run} flush={flush} />
                </article>
              ))}
              {!notes.length && <p>开始聊故事后，资料会逐步出现在这里。</p>}
            </div>
          ) : viewStage !== "writing" ? (
            <StageEditor
              key={projectId + viewStage}
              project={project}
              stage={viewStage}
              document={workflow.documents[viewStage]}
              state={state}
              profileId={model?.id}
              run={run}
              register={register}
            />
          ) : readingPane ? (
            <Reader
              state={state}
              projectId={projectId}
              run={run}
              flush={flush}
              register={register}
              compact
              onRevisionRequest={(r) => {
                setReadingPane(false);
                setPaneRequest(r);
                editMessage(r.text ?? "请修改所选内容");
                setSelected(r.chapterIds[0] ?? selected);
              }}
            />
          ) : chapter ? (
            <ChapterEditor
              flush={flush}
              key={chapter.id}
              chapter={chapter}
              state={state}
              run={run}
              register={register}
              conversational
            />
          ) : (
            <div className="manuscript-empty">
              <span className="eyebrow">故事的第一页</span>
              <h2>先找到让你想读下去的开头</h2>
              <p>
                在左边聊一聊，或直接让 AI 试写。
                <br />
                正文会出现在这里，你可以一边读，一边改。
              </p>
              <div className="paper-lines">
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
