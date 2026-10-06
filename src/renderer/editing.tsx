import { useEffect, useRef, useState } from "react";
import type { Command, RecordMeta } from "../shared/types";
import type { Run } from "./api";
export type Flush = () => Promise<boolean>;
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
) {
  const checkpoint = useRef(JSON.stringify(value)),
    valueRef = useRef(value),
    saveRef = useRef(save),
    resolver = useRef<((ok: boolean) => void) | null>(null);
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [, redraw] = useState(0);
  valueRef.current = value;
  saveRef.current = save;
  const dirty = JSON.stringify(value) !== checkpoint.current;
  useEffect(() => {
    if (!register) return;
    return register(async () => {
      if (JSON.stringify(valueRef.current) === checkpoint.current) return true;
      setVisible(true);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    });
  }, [register]);
  const markSaved = (saved: V) => {
    checkpoint.current = JSON.stringify(saved);
    redraw((x) => x + 1);
  };
  function finish(ok: boolean) {
    resolver.current?.(ok);
    resolver.current = null;
    setVisible(false);
  }
  const dialog = visible ? (
    <div className="modal-scrim">
      <section
        className="card modal"
        role="dialog"
        aria-modal="true"
        aria-label="尚有未保存的修改"
      >
        <h2>尚有未保存的修改</h2>
        <p>保存这份表单后再离开，或返回继续编辑。</p>
        <div className="toolbar">
          <button
            type="button"
            className="primary"
            disabled={busy}
            autoFocus
            onClick={() => {
              setBusy(true);
              void saveRef
                .current()
                .then(() => finish(true))
                .catch(() => finish(false))
                .finally(() => setBusy(false));
            }}
          >
            保存后离开
          </button>
          <button type="button" disabled={busy} onClick={() => finish(false)}>
            返回编辑
          </button>
          <button type="button" disabled={busy} onClick={() => finish(true)}>
            放弃修改并离开
          </button>
        </div>
      </section>
    </div>
  ) : null;
  return { dirty, markSaved, dialog };
}
