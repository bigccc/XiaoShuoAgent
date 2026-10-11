import { useEffect, useRef, useState } from "react";
import type { AppState, AuthoringStage } from "../shared/types";
import type { Run } from "./api";
import type { Flush, Register } from "./editing";
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

export function Conversation({
  state,
  projectId,
  run,
  flush,
  register,
  showProfiles,
  showNotes,
}: {
  state: AppState;
  projectId: string;
  run: Run;
  flush: Flush;
  register: Register;
  showProfiles: () => void;
  showNotes: () => void;
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
  const last = turns.at(-1);
  const chapters = state.chapters
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const notes = state.notes.filter((n) => n.projectId === projectId && !n.archived);
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
  const busy = sending || !!active;
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
  }, [last?.id, last?.revision, sending]);
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
        text: message,
        profileId: model.id,
        stage: viewStage,
        ...(chapter ? { chapterId: chapter.id } : {}),
        ...(proposalTurnId ? { proposalTurnId } : {}),
      });
      editMessage("");
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="conversation-workspace" aria-label="对话创作工作区">
      <div className="conversation-pane">
        <header className="conversation-heading">
          <div className="eyebrow">想法在这里，慢慢长成故事</div>
          <h1>和 AI 一起写故事</h1>
          <p>
            当前阶段：{stageNames[workflow.activeStage]} ·{" "}
            {workflow.activeStage === "writing"
              ? "逐章推进故事"
              : "AI 准备方案，你来判断方向"}
          </p>
        </header>
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
          {!turns.length && (
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
                {(chapters.length
                  ? [
                      "帮我梳理当前故事，推荐下一步",
                      "继续下一章",
                      "聊聊当前这一章可以怎样改进",
                    ]
                  : [
                      "我还没有想法，推荐一个完整的故事概要",
                      "我有一个想法，想和你聊聊",
                      "先构思一部有温情的悬疑小说",
                    ]
                ).map((s) => (
                  <button key={s} onClick={() => editMessage(s)}>
                    {s}
                    <span>↗</span>
                  </button>
                ))}
              </div>
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
                  <div className="thinking" role="status">
                    正在构思和写作…完成后会自动保存到右侧。
                  </div>
                ) : (
                  <div>{t.reply || t.error || "本轮尚未完成"}</div>
                )}
                {t.reply && t.error && <p className="error">{t.error}</p>}
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
                {t.usage?.totalTokens != null && (
                  <details className="chat-details">
                    <summary>本轮用量</summary>
                    <span>{t.usage.totalTokens.toLocaleString()} Token</span>
                  </details>
                )}
                {t.status === "failed" && t.response && (
                  <details className="chat-details">
                    <summary>查看尚未应用的回复</summary>
                    <p>{t.response.message}</p>
                    {t.response.artifacts?.map((a, i) => (
                      <div key={a.stage + i}>
                        <h3>{stageNames[a.stage]}</h3>
                        <pre>{a.content ?? a.blocks?.map(b => `${b.title ?? (b.field ? fieldLabels[b.field] : "")}\n${b.text ?? ""}`).join("\n\n")}</pre>
                        <p>{state.syncJobs.filter(j => j.projectId === projectId && j.stage === a.stage).at(-1)?.error ?? "成果仍保留，请处理同步后继续。"}</p>
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
        </div>
        <div className="conversation-compose">
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
          {!model && (
            <div className="model-nudge">
              <span>添加你使用的模型，就能开始创作。</span>
              <button onClick={showProfiles}>去配置模型</button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send().catch(() => {});
            }}
          >
            <textarea
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
                <summary>{model?.name ?? "尚未配置模型"}</summary>
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
                  管理模型
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
          {authoringStages.map((stage, index) => {
            const doc =
              stage === "writing" ? undefined : workflow.documents[stage];
            return (
              <button
                key={stage}
                aria-label={stageNames[stage]}
                aria-current={
                  stage === workflow.activeStage ? "step" : undefined
                }
                className={viewStage === stage && !showData ? "selected" : ""}
                onClick={() =>
                  void flush().then((ok) => {
                    if (ok) showStage(stage);
                  })
                }
              >
                <span className="stage-number">
                  {doc?.approved ? "✓" : index + 1}
                </span>
                <span>
                  {stageNames[stage]}
                  <small>
                    {stage === "writing"
                      ? stage === workflow.activeStage
                        ? "进行中"
                        : "规划后开始"
                      : doc?.sync?.status === "conflict"
                        ? "待选择"
                        : doc?.sync?.status === "running"
                          ? "同步中"
                          : doc?.sync && doc.sync.status !== "synced"
                            ? "待同步"
                      : doc?.needsReview
                        ? "待同步"
                        : doc?.approved
                          ? "已确认"
                          : doc?.content.trim()
                            ? "待确认"
                            : "待准备"}
                  </small>
                </span>
              </button>
            );
          })}
        </nav>
        <header className="manuscript-heading">
          <div className="manuscript-tabs">
            <span className="current-stage-label">
              {showData ? "资料" : stageNames[viewStage]}
            </span>
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
          ) : chapter ? (
            <ChapterEditor
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
