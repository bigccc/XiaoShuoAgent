import { useEffect, useRef, useState } from "react";
import type { Command, RecordMeta } from "../shared/types";
import type { Run } from "./api";
import { Modal } from "./modal";
export type Flush = (reason?: "save" | "leave") => Promise<boolean>;
export type Register = (flush: Flush) => () => void;
export function useEditor<T extends RecordMeta, V>(
  entity: T,
  initial: (entity: T) => V,
  command: (entity: T, value: V) => Command,
  run: Run,
  register: Register,
) {
  const [value, setValue] = useState(() => initial(entity)),
    [status, setStatus] = useState("已保存到本机");
  const valueRef = useRef(value),
    entityRef = useRef(entity),
    dirty = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    chain = useRef<Promise<boolean>>(Promise.resolve(true)),
    blocked = useRef(false);
  const saveRef = useRef<Flush>(async () => true);
  saveRef.current = () => {
    clearTimeout(timer.current);
    chain.current = chain.current.then(async () => {
      if (blocked.current) return false;
      while (dirty.current) {
        const captured = valueRef.current;
        setStatus("正在保存…");
        try {
          const result = await run(command(entityRef.current, captured));
          entityRef.current = {
            ...entityRef.current,
            revision: result.revision ?? entityRef.current.revision,
          };
          if (captured === valueRef.current) dirty.current = false;
          setStatus(dirty.current ? "待保存…" : "已保存到本机");
        } catch {
          blocked.current = true;
          setStatus("保存失败，内容仍在编辑器中");
          return false;
        }
      }
      return true;
    });
    return chain.current;
  };
  useEffect(() => register(() => saveRef.current()), [register]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!dirty.current && !blocked.current) {
      entityRef.current = entity;
      const next = initial(entity);
      valueRef.current = next;
      setValue(next);
    }
  }, [entity.revision]);
  function edit(next: V) {
    valueRef.current = next;
    setValue(next);
    dirty.current = true;
    setStatus("待保存…");
    clearTimeout(timer.current);
    if (!blocked.current)
      timer.current = setTimeout(() => void saveRef.current(), 450);
  }
  const flush = () => saveRef.current();
  return {
    value,
    edit,
    status,
    flush,
    failed: blocked.current,
    retry: () => {
      blocked.current = false;
      return flush();
    },
    reload: () => {
      entityRef.current = entity;
      dirty.current = false;
      blocked.current = false;
      const next = initial(entity);
      valueRef.current = next;
      setValue(next);
      setStatus("已重新载入本机版本");
    },
  };
}
export function useManualGuard<V>(
  value: V,
  save: () => Promise<void>,
  register?: Register,
  options: { saveLabel?: string; description?: string; canSave?: boolean } = {},
) {
  const checkpoint = useRef(JSON.stringify(value)),
    valueRef = useRef(value),
    saveRef = useRef(save),
    resolver = useRef<((ok: boolean) => void) | null>(null),
    optionsRef = useRef(options),
    saving = useRef<Promise<boolean> | null>(null),
    anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [saveError, setSaveError] = useState(""),
    [, redraw] = useState(0);
  valueRef.current = value;
  saveRef.current = save;
  optionsRef.current = options;
  const dirty = JSON.stringify(value) !== checkpoint.current;
  useEffect(() => {
    if (!register) return;
    return register(async (reason) => {
      if (JSON.stringify(valueRef.current) === checkpoint.current) return true;
      if (saving.current) return saving.current;
      if (reason === "save") return performSave();
      if (resolver.current) return false;
      setVisible(true);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    });
  }, [register]);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  function performSave(): Promise<boolean> {
    if (saving.current) return saving.current;
    if (optionsRef.current.canSave === false) {
      window.dispatchEvent(new CustomEvent("novel-save-error", { detail: "这份表单尚未填写完整，请检查必填字段后保存。" }));
      return Promise.resolve(false);
    }
    const form = anchor.current?.closest("form");
    if (form && !form.reportValidity()) {
      setSaveError("请返回编辑，检查必填字段后保存。");
      return Promise.resolve(false);
    }
    setSaveError("");
    setBusy(true);
    saving.current = Promise.resolve().then(() => saveRef.current()).then(() => true).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "保存失败，内容仍在编辑器中，请检查后重试。";
      setSaveError(message);
      window.dispatchEvent(new CustomEvent("novel-save-error", { detail: message }));
      return false;
    }).finally(() => { saving.current = null; setBusy(false); });
    return saving.current;
  }
  const markSaved = (saved: V) => {
    checkpoint.current = JSON.stringify(saved);
    redraw((x) => x + 1);
  };
  function finish(ok: boolean) {
    resolver.current?.(ok);
    resolver.current = null;
    setVisible(false);
  }
  const dialog = <><span ref={anchor} hidden />{visible ? (
    <Modal label="尚有未保存的修改" busy={busy} onClose={() => finish(false)}>
        <h2>尚有未保存的修改</h2>
        <p>{options.description ?? "保存这份表单后再离开，或返回继续编辑。"}</p>
        {saveError && <p className="error" role="alert">{saveError}</p>}
        <div className="toolbar">
          <button
            type="button"
            className="primary"
            disabled={busy || options.canSave === false}
            autoFocus
            onClick={() => {
              void performSave().then(ok => { if (ok) finish(true); });
            }}
          >
            {options.saveLabel ?? "保存后离开"}
          </button>
          <button type="button" disabled={busy} onClick={() => finish(false)}>
            返回编辑
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => finish(true)}
          >
            放弃修改并离开
          </button>
        </div>
    </Modal>
  ) : null}</>;
  return { dirty, markSaved, dialog, busy, save: performSave };
}
