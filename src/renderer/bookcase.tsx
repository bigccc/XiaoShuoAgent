import { useState } from "react";
import type { AppState } from "../shared/types";
import type { Run } from "./api";
import { Empty, Field } from "./ui";
export function Bookcase({
  state,
  run,
  open,
}: {
  state: AppState;
  run: Run;
  open: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [archived, setArchived] = useState(false);
  const projects = state.projects.filter((p) => p.archived === archived);
  return (
    <div className="page bookcase">
      <div className="page-heading">
        <div>
          <div className="eyebrow">你的私人创作空间</div>
          <h1>书架</h1>
          <p>让一个想法，慢慢长成一本书。</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          新建作品
        </button>
      </div>
      <div className="toolbar">
        <button
          className={!archived ? "active" : ""}
          onClick={() => setArchived(false)}
        >
          创作中
        </button>
        <button
          className={archived ? "active" : ""}
          onClick={() => setArchived(true)}
        >
          已归档
        </button>
        <button
          onClick={() =>
            void run({ type: "file.importBackup" })
              .then((r) => open(r.entityId))
              .catch(() => {})
          }
        >
          导入作品备份
        </button>
      </div>
      {creating && (
        <form
          className="card new-project"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ type: "project.create", title })
              .then((r) => {
                setCreating(false);
                open(r.entityId);
              })
              .catch(() => {});
          }}
        >
          <Field label="作品名称">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="给故事起个名字"
              required
            />
          </Field>
          <button className="primary">创建作品</button>
          <button type="button" onClick={() => setCreating(false)}>
            取消
          </button>
        </form>
      )}
      {!projects.length ? (
        <Empty
          title={archived ? "这里还没有归档作品" : "你的下一部故事，从这里开始"}
        >
          <p>
            新建作品，先写下创意，再整理设定与章节。
            <br />
            已有作品包？可以导入为独立副本。
          </p>
        </Empty>
      ) : (
        <div className="book-grid">
          {projects.map((p, i) => {
            const chapters = state.chapters.filter((c) => c.projectId === p.id),
              words = chapters.reduce(
                (n, c) => n + c.content.replace(/\s/g, "").length,
                0,
              );
            return (
              <article className="book card" key={p.id}>
                <div className="book-cover">
                  <span>
                    小说
                    <br />
                    工坊
                  </span>
                  <strong>{p.title}</strong>
                  <small>{p.genre || "故事正在生长"}</small>
                </div>
                <h2>{p.title}</h2>
                <p>
                  {chapters.length} 章 · {words.toLocaleString()} 字
                </p>
                <button
                  className="primary"
                  aria-label={"打开 " + p.title}
                  onClick={() => open(p.id)}
                >
                  继续创作 →
                </button>
                <button
                  onClick={() =>
                    void run({
                      type: "project.archive",
                      id: p.id,
                      revision: p.revision,
                      archived: !p.archived,
                    }).catch(() => {})
                  }
                >
                  {p.archived ? "取消归档" : "归档"}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
