import { useEffect, useState } from "react";
import type { AppState, Chapter, ChapterVersion } from "../shared/types";
import type { Run } from "./api";
import { useEditor, type Register, type Flush } from "./editing";
import { Empty, Field, SaveStatus, Sources } from "./ui";
export function Chapters({
  state,
  projectId,
  selected,
  setSelected,
  run,
  register,
  flush,
}: {
  state: AppState;
  projectId: string;
  selected: string;
  setSelected: (id: string) => void;
  run: Run;
  register: Register;
  flush: Flush;
}) {
  const chapters = state.chapters
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.ordinal - b.ordinal),
    chapter = chapters.find((c) => c.id === selected) ?? chapters[0];
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>正文与版本</h2>
        <button
          className="primary"
          onClick={() =>
            void flush()
              .then(async (ok) => {
                if (!ok) return;
                return run({
                  type: "chapter.create",
                  projectId,
                  ordinal: (chapters.at(-1)?.ordinal ?? 0) + 1,
                  title: `第${chapters.length + 1}章`,
                }).then((r) => setSelected(r.entityId));
              })
              .catch(() => {})
          }
        >
          新建章节
        </button>
        {chapters.map((c) => (
          <button
            key={c.id}
            className={"item " + (chapter?.id === c.id ? "selected" : "")}
            onClick={() => void flush().then((ok) => ok && setSelected(c.id))}
          >
            <small>
              第 {c.ordinal} 章 ·{" "}
              {c.wordCount ?? c.content.replace(/\s/g, "").length} 字
            </small>
            <strong>{c.title}</strong>
            <span className="badge">
              {c.status === "confirmed" ? "已确认" : "草稿"}
            </span>
            {c.needsReview && <span className="badge warn">需要复核</span>}
          </button>
        ))}
      </aside>
      {chapter ? (
        <ChapterEditor
          key={chapter.id}
          chapter={chapter}
          state={state}
          run={run}
          register={register}
        />
      ) : (
        <Empty title="开始写第一章">
          <p>每一章都有独立的草稿、确认状态与版本历史。</p>
        </Empty>
      )}
    </div>
  );
}
export function ChapterEditor(props: {
  chapter: Chapter;
  state: AppState;
  run: Run;
  register: Register;
  conversational?: boolean;
}) {
  const [chapter, setChapter] = useState<Chapter | undefined>(() =>
    props.chapter.contentLoaded === false ? undefined : props.chapter,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    if (props.chapter.contentLoaded !== false) setChapter(props.chapter);
    else
      void window.novel
        .chapter(props.chapter.id)
        .then((c) => {
          if (current) setChapter(c);
        })
        .catch(() => {
          if (current)
            setError("正文读取失败，请重新打开。编辑器尚未载入正文。");
        });
    return () => {
      current = false;
    };
  }, [props.chapter.id, props.chapter.revision]);
  if (!chapter)
    return (
      <div className="page" role="status">
        {error || "正在读取正文…"}
      </div>
    );
  return <HydratedChapterEditor {...props} chapter={chapter} />;
}
function HydratedChapterEditor({
  chapter,
  state,
  run,
  register,
  conversational = false,
}: {
  chapter: Chapter;
  state: AppState;
  run: Run;
  register: Register;
  conversational?: boolean;
}) {
  const [loadedVersions, setLoadedVersions] = useState<ChapterVersion[]>([]);
  const [history, setHistory] = useState(false),
    [chosen, setChosen] = useState("");
  const editor = useEditor(
      chapter,
      (c) => ({
        title: c.title,
        content: c.content,
        style: c.style,
        pace: c.pace,
      }),
      (c, v) => ({
        type: "chapter.save",
        id: c.id,
        revision: c.revision,
        ...v,
      }),
      run,
      register,
    ),
    v = editor.value;
  useEffect(() => {
    let current = true;
    if (history)
      void window.novel.chapterVersions(chapter.id).then((v) => {
        if (current) setLoadedVersions(v);
      });
    return () => {
      current = false;
    };
  }, [history, chapter.id, chapter.revision]);
  const versions = [
    ...state.versions,
    ...loadedVersions.filter((v) => !state.versions.some((x) => x.id === v.id)),
  ]
    .filter((x) => x.chapterId === chapter.id)
    .sort(
      (a, b) =>
        b.chapterRevision - a.chapterRevision ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const compare =
    versions.find((x) => x.id === chosen) ??
    versions.find((x) => x.content !== v.content) ??
    versions[0];
  async function confirm() {
    if (!(await editor.flush())) return;
    const current = await window.novel.chapter(chapter.id);
    await run({
      type: "chapter.confirm",
      id: chapter.id,
      revision: current.revision,
    });
  }
  async function restore() {
    if (!compare || !(await editor.flush())) return;
    const current = await window.novel.chapter(chapter.id);
    await run({
      type: "chapter.restore",
      id: chapter.id,
      revision: current.revision,
      versionId: compare.id,
    });
  }
  return (
    <section className="page chapter-editor">
      <div className="chapter-toolbar">
        <span className="eyebrow">第 {chapter.ordinal} 章</span>
        <span className="badge">
          {conversational
            ? chapter.writingStage === "opening"
              ? "试写开篇"
              : "当前正文"
            : chapter.status === "confirmed"
              ? "已确认"
              : "草稿"}
        </span>
        <span>{v.content.replace(/\s/g, "").length.toLocaleString()} 字</span>
        <button onClick={() => setHistory(!history)}>历史版本</button>
        {!conversational && (
          <button
            className="primary"
            onClick={() => void confirm().catch(() => {})}
          >
            确认正文
          </button>
        )}
      </div>
      <SaveStatus editor={editor} />
      {chapter.needsReview && (
        <div className="hint warn">
          本章有待复核的改动，可以在对话中要求 AI 检查相关情节。
        </div>
      )}
      <Field label="章节标题">
        <input
          className="chapter-title"
          value={v.title}
          onChange={(e) => editor.edit({ ...v, title: e.target.value })}
        />
      </Field>
      {!conversational && (
        <div className="form-grid compact">
          <Field label="本章文风">
            <input
              value={v.style}
              onChange={(e) => editor.edit({ ...v, style: e.target.value })}
              placeholder="空白时使用作品文风"
            />
          </Field>
          <Field label="本章节奏">
            <input
              value={v.pace}
              onChange={(e) => editor.edit({ ...v, pace: e.target.value })}
              placeholder="空白时使用作品节奏"
            />
          </Field>
        </div>
      )}
      <Field label="章节正文">
        <textarea
          className="prose"
          value={v.content}
          onChange={(e) => editor.edit({ ...v, content: e.target.value })}
          placeholder="从一句话开始。文字会自动保存在本机。"
        />
      </Field>
      {history && (
        <section className="history card">
          <h2>历史版本对比</h2>
          <Field label="选择历史版本">
            <select
              value={compare?.id ?? ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              {versions.map((x) => (
                <option key={x.id} value={x.id}>
                  {new Date(x.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {
                    {
                      create: "创建",
                      save: "编辑",
                      confirm: "确认",
                      restore: "恢复",
                      "ai-candidate": "AI 候选",
                    }[x.reason]
                  }{" "}
                  · {x.content.length} 字
                </option>
              ))}
            </select>
          </Field>
          {compare && (
            <>
              <div className="compare">
                <div>
                  <h3>当前正文</h3>
                  <pre>{v.content || "（空白）"}</pre>
                </div>
                <div>
                  <h3>历史正文 · {compare.title}</h3>
                  <pre>{compare.content || "（空白）"}</pre>
                </div>
              </div>
              <Sources sources={compare.sourceRevisions} state={state} />
              <p className="muted">
                恢复会保留当前版本，之后可以接着编辑或继续创作。
              </p>
              <button onClick={() => void restore().catch(() => {})}>
                恢复此版本
              </button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
