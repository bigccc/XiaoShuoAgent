/** Some compatible models return a JSON-object envelope inside message.content.
 * Unwrap only this exact two-field transport shape; additional fields may carry
 * decisions and must reach the strict domain parser rather than being discarded. */
export function unwrapWritingJson(raw: string): string {
  let text = raw.trim();
  for (let depth = 0; depth < 3; depth++) {
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    text = normalizeQuotationEscapes(text);
    let value: unknown;
    try { value = JSON.parse(text); } catch { return text; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return text;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || item.type !== "json_object" || typeof item.content !== "string") return text;
    text = item.content.trim();
  }
  return text;
}

// Chinese quotation marks are literal characters in JSON. Some models escape
// them as if they were ASCII quotes. Repair only this presentation mistake,
// respecting doubled backslashes and leaving all other escapes to JSON.parse.
function normalizeQuotationEscapes(text: string): string {
  let result = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === "\\" && i + 1 < text.length) {
      const next = text[++i];
      result += "“”‘’".includes(next) ? next : char + next;
      continue;
    }
    if (char === '"') quoted = !quoted;
    result += char;
  }
  return result;
}

/** Salvage only syntactically isolated optional metadata, never story/control
 * fields or an incomplete root. All source bytes are accounted for. */
export function recoverWritingFields(text: string): { value: Record<string, unknown>; omitted: string[] } {
  const fail = (): never => { throw Error("Incomplete writing object"); };
  if (!text.startsWith("{") || !text.endsWith("}")) return fail();
  const stack = ["{"], parts: string[] = [];
  let quoted = false, start = 1;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === "\\") { i++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return fail();
      if (!stack.length) {
        if (i !== text.length - 1) return fail();
        parts.push(text.slice(start, i));
      }
    } else if (char === "," && stack.length === 1) {
      parts.push(text.slice(start, i)); start = i + 1;
    }
  }
  if (quoted || stack.length) return fail();
  const value: Record<string, unknown> = Object.create(null), omitted: string[] = [], seen = new Set<string>();
  for (const part of parts) {
    const match = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(part);
    if (!match) return fail();
    const key = JSON.parse(match[1]);
    if (seen.has(key)) return fail();
    seen.add(key);
    try {
      const field = JSON.parse(`{${part}}`);
      if (Object.keys(field).length !== 1) return fail();
      value[key] = field[key];
    } catch (error) {
      if (!["scenes", "states"].includes(key)) throw error;
      // A missing comma can attach a following root control to this part.
      // Omit only a self-contained array value, never syntax after that value.
      const source = part.slice(match[0].length).trim();
      if (!isolatedArray(source)) return fail();
      omitted.push(key);
    }
  }
  if (!omitted.length || typeof value.title !== "string" || typeof value.content !== "string") return fail();
  return { value, omitted };
}

function isolatedArray(text: string): boolean {
  if (!text.startsWith("[")) return false;
  const stack: string[] = []; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === "\\") { i++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "[" || char === "{") stack.push(char);
    else if (char === "]" || char === "}") {
      if (stack.pop() !== (char === "]" ? "[" : "{")) return false;
      if (!stack.length) return text.slice(i + 1).trim() === "";
    }
  }
  return false;
}
