import { contextHeader, type BuiltContext, type ContextDocument } from "./context";
import { DomainError } from "../shared/validation";

/** Full-source windows with overlapping text at both document and window edges.
 * This covers every selected character, not every possible distant source pair. */
export function checkWindows(context: BuiltContext, maxChars: number): BuiltContext[] {
  const render = (documents: ContextDocument[]) => documents.map(d => contextHeader(d) + d.text).join("\n\n");
  if (render(context.documents).length <= maxChars)
    return [{ ...context, text: render(context.documents), materials: [] }];
  const parts: ContextDocument[] = [];
  for (const doc of context.documents) {
    const capacity = Math.floor(maxChars / 2) - contextHeader(doc).length - 2;
    if (capacity < 1) throw new DomainError("VALIDATION", "检查上下文空间不足以容纳来源标记");
    if (!doc.text.length) { parts.push(doc); continue; }
    let start = 0;
    while (start < doc.text.length) {
      let end = Math.min(doc.text.length, start + capacity);
      if (end < doc.text.length) {
        const text = doc.text.slice(start, end);
        const boundary = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("。"));
        if (boundary >= capacity / 2) end = start + boundary + 1;
      }
      parts.push({ ...doc, text: doc.text.slice(start, end) });
      if (end === doc.text.length) break;
      start = end - Math.min(256, Math.floor((end - start) / 4));
    }
  }
  const windows: BuiltContext[] = [];
  const save = (documents: ContextDocument[]) => windows.push({
    ...context, documents, text: render(documents), materials: [],
    sources: documents.map(d => d.source),
  });
  let current: ContextDocument[] = [];
  for (const part of parts) {
    if (current.length && render([...current, part]).length > maxChars) {
      save(current);
      current = [current[current.length - 1]];
    }
    current.push(part);
  }
  if (current.length) save(current);
  return windows;
}
