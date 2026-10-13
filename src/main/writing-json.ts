/** Some compatible models return a JSON-object envelope inside message.content.
 * Unwrap only this exact two-field transport shape; additional fields may carry
 * decisions and must reach the strict domain parser rather than being discarded. */
export function unwrapWritingJson(raw: string): string {
  let text = raw.trim();
  for (let depth = 0; depth < 3; depth++) {
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    let value: unknown;
    try { value = JSON.parse(text); } catch { return text; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return text;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || item.type !== "json_object" || typeof item.content !== "string") return text;
    text = item.content.trim();
  }
  return text;
}
