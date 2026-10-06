import { useState } from "react";
import type { AppState, ModelProfile, ModelPurpose } from "../shared/types";
import type { Run } from "./api";
import { Empty, Field } from "./ui";
import { useManualGuard, type Register, type Flush } from "./editing";
const purposes = { planning: "规划", writing: "正文", checking: "检查" };
export function Profiles({
  state,
  run,
  register,
  flush,
}: {
  state: AppState;
  run: Run;
  register: Register;
  flush: Flush;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const profile = state.profiles.find((p) => p.id === selected);
  return (
    <div className="split-page">
      <aside className="item-list">
        <h2>模型设置</h2>
        <button
          className="primary"
          onClick={() => void flush().then((ok) => ok && setSelected("new"))}
        >
          新增模型
        </button>
        {state.profiles.map((p) => (
          <button
            className={"item " + (p.id === selected ? "selected" : "")}
            key={p.id}
            onClick={() => void flush().then((ok) => ok && setSelected(p.id))}
          >
            <small>
              {purposes[p.purpose]} · {p.model}
            </small>
            <strong>{p.name}</strong>
            <span className="badge">
              {p.hasKey ? "密钥已保护" : "未配置密钥"}
            </span>
          </button>
        ))}
      </aside>
      {selected ? (
        <ProfileForm
          key={selected}
          profile={profile}
          state={state}
          run={run}
          saved={setSelected}
          register={register}
        />
      ) : (
        <Empty title="连接你自己的模型">
          <p>
            添加 OpenAI 兼容的 API 地址、模型名称和密钥。
            <br />
            规划、正文、检查可以分别选用不同配置。
            <br />
            密钥由 macOS 钥匙串保护，作品备份不含密钥。
          </p>
          <button
            onClick={() => void flush().then((ok) => ok && setSelected("new"))}
          >
            新增模型
          </button>
        </Empty>
      )}
    </div>
  );
}
function ProfileForm({
  profile,
  state,
  run,
  saved,
  register,
}: {
  profile?: ModelProfile;
  state: AppState;
  run: Run;
  saved: (id: string) => void;
  register: Register;
}) {
  const [v, set] = useState({
    name: profile?.name ?? "",
    baseUrl: profile?.baseUrl ?? "",
    model: profile?.model ?? "",
    purpose: profile?.purpose ?? ("writing" as ModelPurpose),
    apiKey: "",
  });
  const [testId, setTestId] = useState("");
  const test = state.tasks.find((t) => t.id === testId);
  async function save() {
    const { apiKey, ...fields } = v;
    const result = await run({
      type: "profile.save",
      ...(profile ? { id: profile.id, revision: profile.revision } : {}),
      ...fields,
      ...(apiKey ? { apiKey } : {}),
    });
    const clean = { ...v, apiKey: "" };
    guard.markSaved(clean);
    set(clean);
    saved(result.entityId);
  }
  const guard = useManualGuard(v, save, register);
  return (
    <section className="page">
      <div className="eyebrow">本机配置 / 密钥保护</div>
      <h1>{profile ? "编辑模型" : "新增模型"}</h1>
      <p>填写服务商提供的兼容接口；连接测试会发起真实的小额请求。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save().catch(() => {});
        }}
      >
        {guard.dialog}
        {guard.dirty && <p className="small warn">此配置有未保存的修改</p>}
        <Field label="配置名称">
          <input
            required
            value={v.name}
            onChange={(e) => set({ ...v, name: e.target.value })}
          />
        </Field>
        <Field label="API 地址">
          <input
            required
            value={v.baseUrl}
            placeholder="https://服务商地址/v1"
            onChange={(e) => set({ ...v, baseUrl: e.target.value })}
          />
        </Field>
        <Field label="模型名称">
          <input
            required
            value={v.model}
            onChange={(e) => set({ ...v, model: e.target.value })}
          />
        </Field>
        <Field label="默认用途">
          <select
            value={v.purpose}
            onChange={(e) =>
              set({ ...v, purpose: e.target.value as ModelPurpose })
            }
          >
            {Object.entries(purposes).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="API 密钥">
          <input
            type="password"
            autoComplete="new-password"
            value={v.apiKey}
            placeholder={
              profile?.hasKey ? "已保存；留空保留现有密钥" : "仅由本机安全存储"
            }
            onChange={(e) => set({ ...v, apiKey: e.target.value })}
          />
        </Field>
        {profile?.hasKey && <p className="success">已安全保存密钥</p>}
        <div className="toolbar">
          <button className="primary">保存模型</button>
          {profile && (
            <>
              <button
                type="button"
                onClick={() =>
                  void run({ type: "model.test", profileId: profile.id })
                    .then((r) => setTestId(r.entityId))
                    .catch(() => {})
                }
              >
                测试连接
              </button>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  void run({
                    type: "profile.delete",
                    id: profile.id,
                    revision: profile.revision,
                  })
                    .then(() => saved("new"))
                    .catch(() => {})
                }
              >
                删除模型
              </button>
            </>
          )}
        </div>
      </form>
      {test && (
        <div className="card" role="status">
          {test.status === "completed"
            ? "连接成功"
            : (test.error ?? "正在测试连接…")}
        </div>
      )}
    </section>
  );
}
