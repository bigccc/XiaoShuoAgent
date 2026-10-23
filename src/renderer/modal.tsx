import { useLayoutEffect, useRef, type ReactNode } from "react";
export function Modal({ label, children, onClose, busy = false, wide = false }: { label: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current!;
    dialog.showModal();
    (dialog.querySelector<HTMLElement>("[autofocus]:not(:disabled), button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? dialog).focus();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={`card modal native-modal${wide ? " modal-wide" : ""}`} aria-label={label} aria-modal="true" aria-busy={busy} tabIndex={-1}
    onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={e => {
      if (e.key !== "Tab") return;
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [contenteditable='true'], [tabindex]:not([tabindex='-1'])")).filter(el => !el.matches(":disabled") && el.getClientRects().length > 0);
      e.preventDefault();
      if (!controls.length) { e.currentTarget.focus(); return; }
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = current < 0 ? (e.shiftKey ? controls.length - 1 : 0) : (current + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next].focus();
    }}>{children}</dialog>;
}
