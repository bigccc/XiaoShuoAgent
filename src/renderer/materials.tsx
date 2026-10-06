import { useState } from "react";
import type { AppState, Material } from "../shared/types";
import type { Run } from "./api";
import { Field, Empty } from "./ui";
import { useManualGuard, type Register, type Flush } from "./editing";
export type MaterialDraft = Pick<
  Material,
  "type" | "title" | "source" | "content" | "explanation" | "approved"
>;
export function Materials({
  state,
  projectId,
  run,
  register,
  flush,
}: {
  state: AppState;
  projectId?: string;
  run: Run;
  register: Register;
  flush: Flush;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [source, setSource] = useState(""),
    [kind, setKind] = useState<"expression" | "plot">("expression");
  const material = state.materials.find((m) => m.id === selected);
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>共享素材库</h2>
        <button
          className="primary"
          onClick={() => void flush().then((ok) => ok && setSelected("new"))}
        >
          粘贴新素材
        </button>
        <Field label="导入来源备注">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="书名、作者、链接或授权说明"
          />
        </Field>
        <Field label="导入素材类型">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="expression">候选表达</option>
            <option value="plot">剧情套路</option>
          </select>
        </Field>
        <button
          onClick={() =>
            void flush()
              .then(async (ok) => {
                if (ok) {
                  const r = await run({
                    type: "file.importMaterial",
                    source,
                    materialType: kind,
                  });
                  setSelected(r.entityId);
                }
              })
              .catch(() => {})
          }
        >
          导入 TXT／DOCX
        </button>
        {state.materials.map((m) => (
          <button
            key={m.id}
            className={"item " + (m.id === selected ? "selected" : "")}
            onClick={() => void flush().then((ok) => ok && setSelected(m.id))}
          >
            <small>{m.type === "plot" ? "剧情套路" : "候选表达"}</small>
            <strong>{m.title}</strong>
            <span className="badge">{m.approved ? "已审核" : "待审核"}</span>
            {m.projectReferences.some((r) => r.projectId === projectId) && (
              <span className="badge">本作引用</span>
            )}
          </button>
        ))}
      </aside>
      {selected ? (
        <section className="page">
          <h1>{material ? "编辑素材" : "添加素材"}</h1>
          <p>保留来源和适用条件；审核后才能用于 AI 上下文。</p>
          <MaterialForm
            key={selected}
            material={material}
            run={run}
            saved={setSelected}
            register={register}
          />
          {material && (
            <div className="toolbar">
              {projectId && (
                <button
                  onClick={() =>
                    void run({
                      type: "material.link",
                      id: material.id,
                      revision: material.revision,
                      projectId,
                      linked: !material.projectReferences.some(
                        (r) => r.projectId === projectId,
                      ),
                    }).catch(() => {})
                  }
                >
                  {material.projectReferences.some(
                    (r) => r.projectId === projectId,
                  )
                    ? "取消本作引用"
                    : "引用到本作"}
                </button>
              )}
              <button
                className="danger"
                onClick={() =>
                  void run({
                    type: "material.delete",
                    id: material.id,
                    revision: material.revision,
                  })
                    .then(() => setSelected(null))
                    .catch(() => {})
                }
              >
                删除素材
              </button>
            </div>
          )}
          {!!material?.projectReferences.length && (
            <div className="hint">
              引用保留当时的素材快照，修改共享内容不会静默改写已有引用。
              {material.projectReferences.map((r) => (
                <div key={r.projectId}>
                  {state.projects.find((p) => p.id === r.projectId)?.title ??
                    "已移除作品"}{" "}
                  · 素材版本 {r.snapshot.revision}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <Empty title="为故事收集灵感">
          <p>
            粘贴文字或导入 TXT／DOCX。AI 提取结果需先审阅，
            <br />
            再保存、审核并选择引用。
          </p>
        </Empty>
      )}
    </div>
  );
}
export function MaterialForm({
  material,
  draft,
  run,
  saved,
  register,
}: {
  material?: Material;
  draft?: MaterialDraft;
  run: Run;
  saved?: (id: string) => void;
  register?: Register;
}) {
  const [v, set] = useState<MaterialDraft>(
    material ??
      draft ?? {
        type: "expression",
        title: "",
        source: "",
        content: "",
        explanation: "",
        approved: false,
      },
  );
  const [success, setSuccess] = useState(false);
  async function save() {
    const result = await run({
      type: "material.save",
      ...(material ? { id: material.id, revision: material.revision } : {}),
      materialType: v.type,
      title: v.title,
      source: v.source,
      content: v.content,
      explanation: v.explanation,
      approved: v.approved,
    });
    guard.markSaved(v);
    setSuccess(true);
    saved?.(result.entityId);
  }
  const guard = useManualGuard(v, save, register);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save().catch(() => {});
      }}
    >
      {guard.dialog}
      {guard.dirty && <p className="small warn">此素材有未保存的修改</p>}
      <Field label="素材标题">
        <input
          required
          value={v.title}
          onChange={(e) => set({ ...v, title: e.target.value })}
        />
      </Field>
      <Field label="素材类型">
        <select
          value={v.type}
          onChange={(e) => set({ ...v, type: e.target.value as typeof v.type })}
        >
          <option value="expression">候选表达</option>
          <option value="plot">剧情套路</option>
        </select>
      </Field>
      <Field label="原始来源">
        <input
          required
          value={v.source}
          onChange={(e) => set({ ...v, source: e.target.value })}
        />
      </Field>
      <Field label="素材内容">
        <textarea
          className="background"
          value={v.content}
          onChange={(e) => set({ ...v, content: e.target.value })}
        />
      </Field>
      <Field label="适用条件与局限">
        <textarea
          value={v.explanation}
          onChange={(e) => set({ ...v, explanation: e.target.value })}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={v.approved}
          onChange={(e) => set({ ...v, approved: e.target.checked })}
        />
        我已阅读并审核此素材
      </label>
      <button className="primary">保存素材</button>
      {success && (
        <span className="success" role="status">
          {" "}
          已保存素材
        </span>
      )}
    </form>
  );
}
