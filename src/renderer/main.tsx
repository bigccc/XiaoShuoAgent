import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, Command } from "../shared/types";
import type { Run } from "./api";
import type { Flush, Register } from "./editing";
import { Bookcase } from "./bookcase";
import { ProjectSettings, Notes } from "./settings";
import { Chapters } from "./chapters";
import { Materials } from "./materials";
import { Profiles } from "./profiles";
import { AiPanel, Tasks, Issues } from "./tasks";
import "./style.css";
type View =
  | "bookcase"
  | "project"
  | "notes"
  | "planning"
  | "chapters"
  | "issues"
  | "materials"
  | "profiles"
  | "tasks"
  | "files";
const empty: AppState = {
  schemaVersion: 1,
  projects: [],
  notes: [],
  chapters: [],
  versions: [],
  materials: [],
  profiles: [],
  tasks: [],
  issues: [],
};
function App() {
  const [state, setState] = useState(empty),
    [ready, setReady] = useState(false),
    [projectId, setProjectId] = useState(""),
    [chapterId, setChapterId] = useState(""),
    [view, setView] = useState<View>("bookcase"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const flushers = useRef(new Set<Flush>()),
    pendingFlush = useRef<Promise<boolean> | null>(null),
    refreshId = useRef(0);
  const register: Register = useCallback((flush) => {
    flushers.current.add(flush);
    return () => {
      flushers.current.delete(flush);
    };
  }, []);
  const flush = useCallback(() => {
    if (pendingFlush.current) return pendingFlush.current;
    const handlers = [...flushers.current];
    pendingFlush.current = (async () => {
      await Promise.resolve();
      try {
        for (const handler of handlers) {
          if (flushers.current.has(handler) && !(await handler())) return false;
        }
        return true;
      } finally {
        pendingFlush.current = null;
      }
    })();
    return pendingFlush.current;
  }, []);
  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    const result = await window.novel.snapshot();
    if (id === refreshId.current) {
      setState(result);
      setReady(true);
    }
  }, []);
  const run: Run = useCallback(
    async (command: Command) => {
      let handled = false;
      try {
        const result = await window.novel.invoke(command);
        if (!result.ok) {
          handled = true;
          setError(
            result.error.message +
              (result.error.code === "CONFLICT"
                ? "。请检查本机版本，编辑器中的文字仍保留。"
                : ""),
          );
          throw new Error(result.error.message);
        }
        await refresh();
        return result;
      } catch (e) {
        if (!handled) setError("本机操作失败，请重试并检查磁盘空间。");
        throw e;
      }
    },
    [refresh],
  );
  useEffect(() => {
    void refresh().catch(() =>
      setError("无法读取本机数据，请重启应用并检查磁盘空间。"),
    );
    const timer = setInterval(
      () => void refresh().catch(() => setError("读取本机状态失败，请重试。")),
      1000,
    );
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(
    () =>
      window.novel.onBeforeClose(() => {
        void flush()
          .then((ok) => window.novel.closeReady(ok))
          .catch(() => window.novel.closeReady(false));
      }),
    [flush],
  );
  async function navigate(next: View) {
    if (!(await flush())) return;
    setView(next);
    setError("");
    setNotice("");
  }
  async function open(id: string) {
    if (!(await flush())) return;
    setProjectId(id);
    setChapterId("");
    setView("project");
  }
  const project = state.projects.find((p) => p.id === projectId),
    nav: Array<[View, string]> = [
      ["project", "创意与风格"],
      ["notes", "人物与世界"],
      ["planning", "故事规划"],
      ["chapters", "正文与版本"],
      ["issues", "一致性检查"],
      ["materials", "素材库"],
      ["tasks", "任务与审阅"],
      ["files", "导出与备份"],
    ];
  const selectedChapter =
    state.chapters.find((c) => c.id === chapterId) ??
    state.chapters
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.ordinal - b.ordinal)[0];
  const workView = project && !["profiles", "bookcase", "files"].includes(view);
  return (
    <>
      <header className="window-header">
        <span>✦ 小说工坊</span>
        <span className="window-subtitle">
          {project && view !== "bookcase" ? project.title : "让故事有处安放"}
        </span>
      </header>
      <div className="app">
        <nav className="sidebar" aria-label="创作导航">
          <div className="brand">
            小说工坊<small>XIAOSHUO AGENT</small>
          </div>
          <button
            className={view === "bookcase" ? "active" : ""}
            onClick={() => void navigate("bookcase")}
          >
            书架
          </button>
          {project && (
            <>
              <div className="nav-section">{project.title}</div>
              {nav.map(([id, label]) => (
                <button
                  className={view === id ? "active" : ""}
                  key={id}
                  onClick={() => void navigate(id)}
                >
                  {label}
                </button>
              ))}
            </>
          )}
          <div className="nav-bottom">
            <button
              className={view === "profiles" ? "active" : ""}
              onClick={() => void navigate("profiles")}
            >
              模型设置
            </button>
            {!project && (
              <>
                <button onClick={() => void navigate("materials")}>
                  素材库
                </button>
                <button onClick={() => void navigate("tasks")}>
                  任务与审阅
                </button>
              </>
            )}
            <div className="local-state">
              ● 本机保存
              <br />
              <small>
                {state.persistence?.lastRecoveryAt
                  ? "恢复备份 " +
                    new Date(
                      state.persistence.lastRecoveryAt,
                    ).toLocaleTimeString("zh-CN")
                  : "每 15 分钟自动恢复备份"}
              </small>
            </div>
          </div>
        </nav>
        <div className="workspace">
          {error && (
            <div className="error global-error" role="alert">
              <span>{error}</span>
              <button aria-label="关闭错误提示" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {state.persistence?.recoveryError && (
            <div className="error" role="alert">
              {state.persistence.recoveryError}。请先手动备份作品。
            </div>
          )}
          <div className="workspace-body">
            <main>
              {!ready ? (
                <div className="empty">正在打开本机书架…</div>
              ) : view === "bookcase" ? (
                <Bookcase
                  state={state}
                  run={run}
                  open={(id) => void open(id)}
                />
              ) : view === "profiles" ? (
                <Profiles
                  state={state}
                  run={run}
                  register={register}
                  flush={flush}
                />
              ) : view === "materials" ? (
                <Materials
                  state={state}
                  projectId={project?.id}
                  run={run}
                  register={register}
                  flush={flush}
                />
              ) : view === "tasks" ? (
                <Tasks
                  register={register}
                  state={state}
                  projectId={project?.id}
                  run={run}
                  flush={flush}
                />
              ) : project && view === "project" ? (
                <ProjectSettings
                  key={project.id}
                  project={project}
                  run={run}
                  register={register}
                />
              ) : (project && view === "notes") ||
                (project && view === "planning") ? (
                <Notes
                  key={view + project!.id}
                  state={state}
                  projectId={project!.id}
                  planning={view === "planning"}
                  run={run}
                  register={register}
                />
              ) : project && view === "chapters" ? (
                <Chapters
                  state={state}
                  projectId={project.id}
                  selected={chapterId}
                  setSelected={setChapterId}
                  run={run}
                  register={register}
                  flush={flush}
                />
              ) : project && view === "issues" ? (
                <Issues state={state} projectId={project.id} run={run} />
              ) : project && view === "files" ? (
                <Files
                  state={state}
                  projectId={project.id}
                  run={run}
                  flush={flush}
                  notify={setNotice}
                />
              ) : null}
            </main>
            {workView && (
              <AiPanel
                key={project.id}
                state={state}
                projectId={project.id}
                chapterId={selectedChapter?.id}
                run={run}
                flush={flush}
                showTasks={() => void navigate("tasks")}
                showProfiles={() => void navigate("profiles")}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
function Files({
  state,
  projectId,
  run,
  flush,
  notify,
}: {
  state: AppState;
  projectId: string;
  run: Run;
  flush: Flush;
  notify: (text: string) => void;
}) {
  const [drafts, setDrafts] = useState(false),
    chapters = state.chapters
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.ordinal - b.ordinal);
  async function save(
    type: "file.exportText" | "file.exportDocx" | "file.backup",
  ) {
    if (!(await flush())) return;
    await run({
      type,
      projectId,
      ...(type === "file.backup" ? {} : { includeDrafts: drafts }),
    });
    notify(
      type === "file.backup"
        ? "完整作品备份已保存到所选位置。"
        : "正文已导出到所选位置。",
    );
  }
  return (
    <section className="page">
      <div className="eyebrow">迁移 / 给文字一个出口</div>
      <h1>导出与备份</h1>
      <p>导出默认包含已确认正文；完整作品包保留设定、历史、任务和引用素材。</p>
      <div className="card">
        <h2>导出正文</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={drafts}
            onChange={(e) => setDrafts(e.target.checked)}
          />
          本次导出包含未确认草稿
        </label>
        <div className="chapter-export-list">
          {chapters.map((c) => (
            <div key={c.id}>
              <span>
                {c.ordinal}. {c.title}
              </span>
              <span className="badge">
                {c.status === "confirmed"
                  ? "已确认"
                  : drafts
                    ? "草稿 · 将导出"
                    : "草稿 · 不导出"}
              </span>
            </div>
          ))}
        </div>
        <div className="toolbar">
          <button
            className="primary"
            onClick={() => void save("file.exportText").catch(() => {})}
          >
            导出 TXT
          </button>
          <button onClick={() => void save("file.exportDocx").catch(() => {})}>
            导出 Word（DOCX）
          </button>
        </div>
      </div>
      <div className="card">
        <h2>完整作品备份</h2>
        <p>
          API 配置与密钥均不进入作品包。导入会创建副本，现有作品不会被覆盖。
        </p>
        <div className="toolbar">
          <button onClick={() => void save("file.backup").catch(() => {})}>
            备份完整作品
          </button>
          <button
            onClick={() =>
              void run({ type: "file.importBackup" })
                .then(() => notify("备份已导入为独立副本，请在书架打开。"))
                .catch(() => {})
            }
          >
            导入作品／恢复备份
          </button>
        </div>
        <p className="muted">
          自动恢复文件保留最近 20 份，可从应用数据目录的 recovery
          文件夹选择导入；迁移前请另做手动备份。
        </p>
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
