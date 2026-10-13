/** Same character measure for the writing request, feedback and candidate UI. */
export function countProse(text: string): number {
  const body = text.replace(
    /^\s*(?:#{1,6}\s+[^\n]+|第[\d一二三四五六七八九十百]+章[^\n]*)\n+/,
    "",
  );
  return Array.from(body.replace(/\s/g, "")).length;
}

export function proseRange(target: number): [number, number] {
  return [
    Math.max(1, Math.ceil(target * 0.8)),
    Math.max(1, Math.floor(target * 1.2)),
  ];
}
