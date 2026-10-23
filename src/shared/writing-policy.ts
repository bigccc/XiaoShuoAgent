/** Character targets are author intent; token allowances include reading and checking too. */
export function writingWordRange(target: number) {
  return { min: Math.ceil(target * 0.9), max: Math.floor(target * 1.1) };
}

/** Conservative allowance for a bounded run, not a price quote or usage prediction. */
export function estimateWritingBudget(chapterCount: number, targetWords: number, contextChars: number): number {
  const output = Math.min(32000, Math.max(1024, targetWords * 3));
  let allowance = 20000; // Planning and its input.
  for (let i = 0; i < chapterCount; i++) {
    const input = Math.ceil(Math.min(48000, contextChars + (i + 1) * targetWords * 1.1) * 1.2) + 16000;
    // Initial draft + two revisions; chapter/revision checks and cross-chapter review.
    allowance += 3 * (input + output) + 6 * (input + 3000);
  }
  return Math.min(1_000_000_000, Math.ceil(allowance / 1000) * 1000);
}

export function requestedChapterWords(text: string): number | undefined {
  const match = /每章\s*(?:大约|约|大概)?\s*(\d{1,6})\s*字/.exec(text);
  return match ? Number(match[1]) : undefined;
}
