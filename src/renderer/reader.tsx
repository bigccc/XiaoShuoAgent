import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, Chapter } from "../shared/types";
import {
  locateSelection,
  reviewStatus,
  type ReadingAnnotation,
  type ReadingReview,
  type SearchMatch,
  type SearchResult,
  type TextSelection,
} from "../shared/reader";
import type { RevisionJob } from "../shared/revision";
import type { Run } from "./api";
import type { Flush, Register } from "./editing";
import { ParagraphChanges, Revisions } from "./revisions";
export interface RevisionRequest {
  selection?: TextSelection;
  annotationIds?: string[];
  chapterIds: string[];
  scope: RevisionJob["scope"];
  text?: string;
  proposalOnly?: boolean;
}
function reviewLabel(c: Chapter, r?: ReadingReview) {
  return { unreviewed: "未审", reviewed: "已审", "needs-review": "待复核" }[
    reviewStatus(c, r)
  ];
}
const ignored = () => {};
export function Reader({
  state,
  projectId,
  run,
  flush,
  register,
  onRevisionRequest,
  compact = false,
}: {
  state: AppState;
  projectId: string;
  run: Run;
  flush: Flush;
  register: Register;
  onRevisionRequest: (r: RevisionRequest) => void;
  compact?: boolean;
}) {
  const chapters = useMemo(
    () =>
      state.chapters
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => a.ordinal - b.ordinal),
    [state.chapters, projectId],
  );
  const workspace = state.readingWorkspaces?.find(
    (w) => w.projectId === projectId,
  );
  const reviewsByChapter = useMemo(
    () => new Map((workspace?.reviews ?? []).map((r) => [r.chapterId, r])),
    [workspace?.reviews],
  );
  const pendingChapters = useMemo(
    () =>
      new Set(
        (workspace?.annotations ?? [])
          .filter((a) => a.status === "open")
          .map((a) => a.chapterId),
      ),
    [workspace?.annotations],
  );
  const [active, setActive] = useState(
      () => workspace?.position?.chapterId ?? chapters[0]?.id ?? "",
    ),
    [mode, setMode] = useState<"reading" | "review">(
      () => workspace?.position?.mode ?? "reading",
    );
  const [cache, setCache] = useState<Record<string, Chapter>>({}),
    [selection, setSelection] = useState<TextSelection>(),
    [annotation, setAnnotation] = useState(""),
    [chosenNotes, setChosenNotes] = useState<string[]>([]),
    [filter, setFilter] = useState("all"),
    [titleQuery, setTitleQuery] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<SearchResult>(),
    [searchOffset, setSearchOffset] = useState(0),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [directoryTop, setDirectoryTop] = useState(0),
    [collapsed, setCollapsed] = useState<string[]>([]),
    [volumeForm, setVolumeForm] = useState(false),
    [volumeTitle, setVolumeTitle] = useState(""),
    [from, setFrom] = useState(1),
    [to, setTo] = useState(chapters.length || 1),
    [baseline, setBaseline] = useState<string>();
  const [font, setFont] = useState(
      () => Number(localStorage.getItem("reader-font")) || 19,
    ),
    [line, setLine] = useState(
      () => Number(localStorage.getItem("reader-line")) || 2,
    ),
    [width, setWidth] = useState(
      () => Number(localStorage.getItem("reader-width")) || 720,
    );
  const directory = useRef<HTMLDivElement>(null);
  const searchedText = useRef("");
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const persistenceChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const scroller = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    position = useRef({
      chapterId: active,
      offset: workspace?.position?.offset ?? 0,
      mode,
    }),
    saved = useRef(JSON.stringify(workspace?.position ?? {})),
    target = useRef<{ chapterId: string; offset: number } | null>({
      chapterId: active,
      offset: workspace?.position?.offset ?? 0,
    }),
    loading = useRef(false);
  const index = Math.max(
      0,
      chapters.findIndex((c) => c.id === active),
    ),
    metadata = chapters[index],
    chapter = cache[active],
    near = chapters.slice(Math.max(0, index - 1), index + 2);
  const signature = near.map((c) => `${c.id}:${c.revision}`).join(",");
  const persist = useCallback(() => {
    clearTimeout(timer.current);
    persistenceChain.current = persistenceChain.current.then(async () => {
      const p = position.current;
      if (!p.chapterId || JSON.stringify(p) === saved.current) return true;
      try {
        await run({ type: "reading.position", projectId, ...p });
        saved.current = JSON.stringify(p);
        return true;
      } catch {
        return false;
      }
    });
    return persistenceChain.current;
  }, [projectId, run]);
  useEffect(() => {
    if (metadata && !chapters.some((c) => c.id === active)) {
      setActive(metadata.id);
      target.current = { chapterId: metadata.id, offset: 0 };
      position.current = { chapterId: metadata.id, offset: 0, mode };
    }
  }, [metadata?.id, active]);
  useEffect(() => register(persist), [register, persist]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function remember(chapterId: string, offset: number, nextMode = mode) {
    position.current = {
      chapterId,
      offset: Math.max(0, offset),
      mode: nextMode,
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), 400);
  }
  useEffect(() => {
    let current = true;
    loading.current = true;
    void Promise.all(
      near.map((c) =>
        cacheRef.current[c.id]?.revision === c.revision
          ? Promise.resolve(cacheRef.current[c.id])
          : window.novel.chapter(c.id),
      ),
    )
      .then((values) => {
        if (current) {
          setCache(Object.fromEntries(values.map((c) => [c.id, c])));
          loading.current = false;
        }
      })
      .catch(() => {
        if (current) {
          setSearchError("章节读取失败，请重新打开。");
          loading.current = false;
        }
      });
    return () => {
      current = false;
    };
  }, [signature]);
  useEffect(() => {
    const t = target.current,
      s = scroller.current;
    if (!t || !s || !cache[t.chapterId]) return;
    const el = s.querySelector<HTMLElement>(
      `[data-chapter-id="${t.chapterId}"] .reader-text`,
    );
    if (!el) return;
    requestAnimationFrame(() => {
      if (!target.current) return;
      const n = el.firstChild;
      let rect = el.getBoundingClientRect();
      if (n) {
        const r = document.createRange();
        r.setStart(n, Math.min(t.offset, n.textContent?.length ?? 0));
        r.setEnd(n, Math.min(t.offset + 1, n.textContent?.length ?? 0));
        rect = r.getBoundingClientRect();
      }
      s.scrollTop += rect.top - s.getBoundingClientRect().top - 48;
      target.current = null;
    });
  }, [cache, active]);
  const currentReview = reviewsByChapter.get(active);
  useEffect(() => {
    let current = true;
    setBaseline(undefined);
    if (
      mode === "review" &&
      currentReview &&
      chapter &&
      reviewLabel(metadata, currentReview) === "待复核"
    )
      void window.novel.chapterVersions(active).then((v) => {
        if (current)
          setBaseline(v.find((x) => x.id === currentReview.versionId)?.content);
      });
    return () => {
      current = false;
    };
  }, [active, chapter?.revision, currentReview?.versionId, mode]);
  async function jump(id: string, offset = 0) {
    if (!(await flush())) return;
    target.current = { chapterId: id, offset };
    setActive(id);
    setSelection(undefined);
    remember(id, offset);
    if (cache[id]) setCache((c) => ({ ...c }));
  }
  function capture(id: string) {
    const selected = window.getSelection(),
      el = scroller.current?.querySelector<HTMLElement>(
        `[data-chapter-id="${id}"] .reader-text`,
      ),
      c = cache[id];
    if (!selected?.rangeCount || selected.isCollapsed || !el || !c) return;
    const r = selected.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(el);
    prefix.setEnd(r.startContainer, r.startOffset);
    const start = prefix.toString().length,
      end = start + r.toString().length;
    if (c.content.slice(start, end) !== r.toString()) return;
    setSelection({
      chapterId: id,
      revision: c.revision,
      start,
      end,
      quote: r.toString(),
    });
    setActive(id);
    remember(id, start);
  }
  function scroll() {
    if (target.current || loading.current || !scroller.current) return;
    const s = scroller.current,
      top = s.getBoundingClientRect().top + 60;
    const els = Array.from(s.querySelectorAll<HTMLElement>(".reader-chapter"));
    const el = els.find((e) => e.getBoundingClientRect().bottom > top);
    if (!el) return;
    const id = el.dataset.chapterId!;
    const text = el.querySelector<HTMLElement>(".reader-text");
    let offset = 0;
    if (text) {
      const rect = text.getBoundingClientRect();
      if (rect.top < top) {
        const point = (
          document as Document & {
            caretRangeFromPoint?(x: number, y: number): Range;
          }
        ).caretRangeFromPoint?.(rect.left + 8, top);
        if (point && text.contains(point.startContainer)) {
          const prefix = document.createRange();
          prefix.selectNodeContents(text);
          prefix.setEnd(point.startContainer, point.startOffset);
          offset = prefix.toString().length;
        }
      }
    }
    if (id !== active) {
      target.current = { chapterId: id, offset };
      setActive(id);
    }
    remember(id, offset);
  }
  async function jumpAnnotation(annotation: ReadingAnnotation) {
    try {
      const fresh = await window.novel.chapter(annotation.chapterId);
      const sameContent =
        !!annotation.contentHash &&
        annotation.contentHash === fresh.contentHash;
      const location = locateSelection(
        fresh.content,
        annotation.anchor,
        sameContent ? annotation.anchor.revision : fresh.revision,
      );
      if (!location) {
        setSearchError("原文已变化，无法唯一定位这条批注，请重新核对。");
        return;
      }
      setSearchError("");
      await jump(annotation.chapterId, location.start);
    } catch {
      setSearchError("无法读取批注原文，请重新打开章节。");
    }
  }
  async function jumpMatch(match: SearchMatch) {
    try {
      const current = await window.novel.chapter(match.chapterId);
      const anchor = {
        ...match,
        revision: match.revision,
        quote: searchedText.current,
      };
      const located = locateSelection(
        current.content,
        anchor,
        current.revision,
      );
      if (!located) {
        setSearchError("搜索后的原文已变化，请重新搜索再定位。");
        return;
      }
      await jump(match.chapterId, located.start);
    } catch {
      setSearchError("无法打开搜索命中，请重新搜索。");
    }
  }
  async function search(offset = 0) {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const r = await window.novel.search(projectId, query, offset);
      setResults(r);
      searchedText.current = query;
      setSearchOffset(offset);
    } catch {
      setSearchError("搜索失败，请重试。");
    } finally {
      setSearching(false);
    }
  }
  const rows: (
    | { kind: "volume"; id: string; title: string }
    | { kind: "chapter"; chapter: Chapter }
  )[] = [];
  for (const c of chapters) {
    const v = workspace?.volumes.find(
      (v) => c.ordinal >= v.fromOrdinal && c.ordinal <= v.toOrdinal,
    );
    if (v && c.ordinal === v.fromOrdinal)
      rows.push({ kind: "volume", id: v.id, title: v.title });
    if (v && collapsed.includes(v.id) && !titleQuery) continue;
    const status = reviewLabel(c, reviewsByChapter.get(c.id));
    const pending = pendingChapters.has(c.id);
    if (titleQuery && !`${c.ordinal} ${c.title}`.includes(titleQuery)) continue;
    if (
      (filter === "unreviewed" && status !== "未审") ||
      (filter === "pending" && status !== "待复核" && !pending)
    )
      continue;
    rows.push({ kind: "chapter", chapter: c });
  }
  const start = Math.max(0, Math.floor(directoryTop / 58) - 3),
    visible = rows.slice(start, start + 18),
    notes = (workspace?.annotations ?? []).filter(
      (a) => a.chapterId === active,
    );
  if (!metadata)
    return (
      <div className="empty">
        <h2>还没有正文</h2>
        <p>先在创作中写下第一章，再来看稿。</p>
      </div>
    );
  return (
    <section
      className={"reader-workspace " + (compact ? "reader-compact" : "")}
      aria-label="阅读与审阅工作区"
    >
      <aside className="reader-directory">
        <header>
          <span className="eyebrow">全书目录 · {chapters.length} 章</span>
          <input
            aria-label="章号或标题"
            placeholder="章号 / 标题"
            value={titleQuery}
            onChange={(e) => {
              setTitleQuery(e.target.value);
              setDirectoryTop(0);
              if (directory.current) directory.current.scrollTop = 0;
            }}
          />
          <select
            aria-label="审阅筛选"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setDirectoryTop(0);
              if (directory.current) directory.current.scrollTop = 0;
            }}
          >
            <option value="all">全部章节</option>
            <option value="unreviewed">未审</option>
            <option value="pending">待处理 / 待复核</option>
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input
              aria-label="全文搜索"
              placeholder="搜索正文原文"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button disabled={searching} aria-label="搜索正文">
              搜索正文
            </button>
          </form>
          {searchError && <p className="error">{searchError}</p>}
          {results && (
            <div className="reader-search-results">
              <p>{results.total} 处命中</p>
              {results.matches.map((m, i) => (
                <button key={i} onClick={() => void jumpMatch(m)}>
                  第{m.ordinal}章 · {m.title}
                  <small>{m.excerpt}</small>
                </button>
              ))}
              {searchOffset > 0 && (
                <button
                  disabled={searching}
                  onClick={() => void search(Math.max(0, searchOffset - 40))}
                >
                  上一页命中
                </button>
              )}
              {results.nextOffset !== null && (
                <button
                  disabled={searching}
                  onClick={() => void search(results.nextOffset!)}
                >
                  下一页命中
                </button>
              )}
            </div>
          )}
        </header>
        <div
          ref={directory}
          className="reader-directory-scroll"
          onScroll={(e) => setDirectoryTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: rows.length * 58, position: "relative" }}>
            {visible.map((r, i) => (
              <div
                key={r.kind === "volume" ? r.id : r.chapter.id}
                style={{
                  position: "absolute",
                  top: (start + i) * 58,
                  height: 58,
                  left: 0,
                  right: 0,
                }}
              >
                {r.kind === "volume" ? (
                  <button
                    className="volume-heading"
                    onClick={() =>
                      setCollapsed((c) =>
                        c.includes(r.id)
                          ? c.filter((x) => x !== r.id)
                          : [...c, r.id],
                      )
                    }
                  >
                    {collapsed.includes(r.id) ? "▸" : "▾"} {r.title}
                  </button>
                ) : (
                  <button
                    className={
                      "reader-directory-item " +
                      (active === r.chapter.id ? "selected" : "")
                    }
                    onClick={() => void jump(r.chapter.id)}
                  >
                    <strong>
                      {r.chapter.ordinal}. {r.chapter.title}
                    </strong>
                    <small>
                      {r.chapter.wordCount ??
                        r.chapter.content.replace(/\s/g, "").length}{" "}
                      字 ·{" "}
                      {reviewLabel(
                        r.chapter,
                        reviewsByChapter.get(r.chapter.id),
                      )}
                    </small>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <footer>
          <button onClick={() => setVolumeForm(!volumeForm)}>
            按章范围建卷
          </button>
          {volumeForm && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run({
                  type: "reading.volumeSave",
                  projectId,
                  title: volumeTitle,
                  fromOrdinal: from,
                  toOrdinal: to,
                })
                  .then(() => setVolumeForm(false))
                  .catch(ignored);
              }}
            >
              <input
                aria-label="分卷标题"
                placeholder="卷名"
                value={volumeTitle}
                onChange={(e) => setVolumeTitle(e.target.value)}
              />
              <div className="toolbar">
                <input
                  aria-label="分卷起始章"
                  type="number"
                  min={1}
                  value={from}
                  onChange={(e) => setFrom(Number(e.target.value))}
                />
                <input
                  aria-label="分卷结束章"
                  type="number"
                  min={from}
                  value={to}
                  onChange={(e) => setTo(Number(e.target.value))}
                />
              </div>
              <button disabled={!volumeTitle.trim()}>保存分卷</button>
            </form>
          )}
          <button
            onClick={() =>
              onRevisionRequest({
                scope: "all",
                proposalOnly: true,
                chapterIds: chapters.map((c) => c.id),
                text: "请根据已有章节建议分卷标题和章号范围，只提出建议，由我确认后手动建卷。",
              })
            }
          >
            帮我建议分卷
          </button>
          <small>建议经确认后按范围建卷</small>
        </footer>
      </aside>
      <div className="reader-paper">
        <header className="reader-toolbar">
          <div className="reader-mode">
            <button
              className={mode === "reading" ? "selected" : ""}
              onClick={() => {
                setMode("reading");
                remember(active, position.current.offset, "reading");
              }}
            >
              阅读
            </button>
            <button
              className={mode === "review" ? "selected" : ""}
              onClick={() => {
                setMode("review");
                remember(active, position.current.offset, "review");
              }}
            >
              审阅
            </button>
          </div>
          <details>
            <summary>排版</summary>
            <label>
              字号
              <input
                aria-label="阅读字号"
                type="range"
                min={15}
                max={28}
                value={font}
                onChange={(e) => {
                  setFont(Number(e.target.value));
                  localStorage.setItem("reader-font", e.target.value);
                }}
              />
            </label>
            <label>
              行距
              <input
                aria-label="阅读行距"
                type="range"
                min={1.4}
                max={2.8}
                step={0.1}
                value={line}
                onChange={(e) => {
                  setLine(Number(e.target.value));
                  localStorage.setItem("reader-line", e.target.value);
                }}
              />
            </label>
            <label>
              宽度
              <input
                aria-label="阅读宽度"
                type="range"
                min={420}
                max={960}
                step={20}
                value={width}
                onChange={(e) => {
                  setWidth(Number(e.target.value));
                  localStorage.setItem("reader-width", e.target.value);
                }}
              />
            </label>
          </details>
          <span>第 {metadata.ordinal} 章</span>
          <input
            aria-label="跳转章号"
            type="number"
            min={1}
            placeholder="章号"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const c = chapters.find(
                  (c) => c.ordinal === Number(e.currentTarget.value),
                );
                if (c) void jump(c.id);
              }
            }}
          />
        </header>
        {selection && mode === "reading" && (
          <div className="reader-selection-toolbar">
            <span>选中 {selection.end - selection.start} 字</span>
            <button
              onClick={() => {
                setMode("review");
                remember(active, position.current.offset, "review");
              }}
            >
              添加批注
            </button>
            <button
              onClick={() =>
                onRevisionRequest({
                  scope: "selection",
                  chapterIds: [selection.chapterId],
                  selection,
                })
              }
            >
              修改这段文字
            </button>
            <button
              aria-label="清除阅读选区"
              onClick={() => setSelection(undefined)}
            >
              ×
            </button>
          </div>
        )}
        <div className="reader-scroll" ref={scroller} onScroll={scroll}>
          <div
            className="reader-pages"
            style={{ maxWidth: width, fontSize: font, lineHeight: line }}
          >
            {near.map((c) => (
              <article
                className="reader-chapter"
                data-chapter-id={c.id}
                data-active={c.id === active}
                key={c.id}
              >
                <div className="eyebrow">
                  第 {c.ordinal} 章 · {c.wordCount ?? 0} 字
                </div>
                <h2>{c.title}</h2>
                <div className="reader-text" onMouseUp={() => capture(c.id)}>
                  {cache[c.id]?.content ?? "正在读取正文…"}
                </div>
              </article>
            ))}
          </div>
        </div>
        <footer className="reader-pagination">
          <button
            disabled={!index}
            onClick={() => void jump(chapters[index - 1].id)}
          >
            上一章
          </button>
          <small>
            {metadata.title} · {index + 1} / {chapters.length}
          </small>
          <button
            disabled={index >= chapters.length - 1}
            onClick={() => void jump(chapters[index + 1].id)}
          >
            下一章
          </button>
        </footer>
      </div>
      {mode === "review" && (
        <aside className="reader-review">
          <h3>审阅本章</h3>
          <p className="review-status">
            {reviewLabel(metadata, currentReview) === "已审"
              ? "本章已审"
              : reviewLabel(metadata, currentReview) === "待复核"
                ? "正文已改动 · 待复核"
                : "本章未审"}
          </p>
          <button
            disabled={!chapter}
            onClick={() =>
              chapter &&
              void run({
                type: "reading.review",
                projectId,
                chapterId: chapter.id,
                revision: chapter.revision,
              }).catch(ignored)
            }
          >
            标记本章已审
          </button>
          {baseline !== undefined && chapter && (
            <details>
              <summary>与上次已审正文比较</summary>
              <ParagraphChanges before={baseline} after={chapter.content} />
            </details>
          )}
          {selection && (
            <div className="selection-card">
              <strong>选中 {selection.end - selection.start} 字</strong>
              <blockquote>{selection.quote}</blockquote>
              <textarea
                aria-label="批注内容"
                placeholder="先记下想法，稍后再一起改稿"
                value={annotation}
                onChange={(e) => setAnnotation(e.target.value)}
              />
              <div className="toolbar">
                <button
                  disabled={!annotation.trim()}
                  onClick={() =>
                    void run({
                      type: "reading.annotate",
                      projectId,
                      selection,
                      text: annotation,
                    })
                      .then(() => {
                        setAnnotation("");
                        setSelection(undefined);
                      })
                      .catch(ignored)
                  }
                >
                  保存批注
                </button>
                <button
                  onClick={() =>
                    onRevisionRequest({
                      scope: "selection",
                      chapterIds: [selection.chapterId],
                      selection,
                    })
                  }
                >
                  修改这段文字
                </button>
              </div>
            </div>
          )}
          <h3>本章批注 · {notes.length}</h3>
          {notes.map((a) => (
            <article
              className={
                "annotation-card " + (a.status === "resolved" ? "resolved" : "")
              }
              key={a.id}
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={chosenNotes.includes(a.id)}
                  onChange={(e) =>
                    setChosenNotes((n) =>
                      e.target.checked
                        ? [...n, a.id]
                        : n.filter((id) => id !== a.id),
                    )
                  }
                />
                {a.status === "open" ? "待处理" : "已关闭"}
              </label>
              <button
                className="annotation-quote"
                onClick={() => void jumpAnnotation(a)}
              >
                {a.anchor.quote}
              </button>
              <p>{a.text}</p>
              <button
                onClick={() =>
                  void run({
                    type: "reading.annotationStatus",
                    projectId,
                    id: a.id,
                    status: a.status === "open" ? "resolved" : "open",
                  }).catch(ignored)
                }
              >
                {a.status === "open" ? "复核后关闭" : "重新打开"}
              </button>
            </article>
          ))}
          <button
            disabled={!chosenNotes.length}
            onClick={() =>
              onRevisionRequest({
                scope: "chapters",
                annotationIds: chosenNotes,
                chapterIds: [
                  ...new Set(
                    (workspace?.annotations ?? [])
                      .filter((a) => chosenNotes.includes(a.id))
                      .map((a) => a.chapterId),
                  ),
                ],
              })
            }
          >
            根据所选批注改稿（{chosenNotes.length}）
          </button>
          <p className="muted">改稿后由你复核关闭批注。</p>
          <Revisions state={state} projectId={projectId} run={run} />
        </aside>
      )}
    </section>
  );
}
