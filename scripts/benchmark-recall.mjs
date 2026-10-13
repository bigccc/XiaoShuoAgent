import { createServer } from "vite";
import { performance } from "node:perf_hooks";

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
try {
  const { recallPassages } = await server.ssrLoadModule("/src/main/recall.ts");
  const { buildContext } = await server.ssrLoadModule("/src/main/context.ts");
  const { recallCases, chapter, state } = await server.ssrLoadModule("/tests/fixtures/recall-cases.ts");
  const cases = recallCases().map(c => {
    const recent = c.state.chapters.filter(ch => ch.projectId === "p" && ch.ordinal < c.beforeOrdinal && ch.status === "confirmed").sort((a,b) => a.ordinal - b.ordinal).slice(-3);
    const baseline = buildContext({ ...c.state, chapters: [...c.state.chapters, chapter("baseline-target", c.beforeOrdinal, "", { status: "draft" })] }, "p", {}, ["baseline-target"]);
    const start = performance.now();
    const references = recallPassages(c.state, "p", { query: c.query, beforeOrdinal: c.beforeOrdinal, excludeChapterIds: recent.map(ch => ch.id) });
    const elapsedMs = performance.now() - start;
    // Both strategies are judged against manually labelled evidence IDs, not against each other.
    const baseIds = baseline.documents.filter(d => d.source.kind === "chapter" && c.relevant.includes(d.source.id) && d.text).map(d => d.source.id);
    const combined = [...new Set([...baseIds, ...references.map(r => r.source.id)])];
    return { name: c.name, expected: c.relevant, baselineFound: baseIds, combinedFound: combined,
      missed: c.relevant.filter(id => !combined.includes(id)), unexpected: references.filter(r => !c.relevant.includes(r.source.id)).map(r => r.source.id),
      baselineChars: baseline.text.length, recalledChars: references.reduce((n,r) => n+r.excerpt.length,0), elapsedMs: +elapsedMs.toFixed(3) };
  });
  const large = state(Array.from({length:5000}, (_,i) => chapter(`scale-${i+1}`, i+1, i === 7 ? "阿宁将铜钥匙交给老周。" + "普通叙述。".repeat(600) : "普通叙述。".repeat(600))));
  const start = performance.now();
  const references = recallPassages(large, "p", { query:"铜钥匙 老周", beforeOrdinal:5001 });
  const output = { kind: "deterministic-source-recall", generatedAt: new Date().toISOString(), runtime: process.version, platform: process.platform, arch: process.arch,
    limitations: "自有固定样本；无模型生成、文学质量评测或服务商Token测量。字符量不等于Token。", cases,
    summary: { labelledReferences: cases.reduce((n,c) => n+c.expected.length,0), baselineFound: cases.reduce((n,c) => n+c.baselineFound.length,0), combinedFound: cases.reduce((n,c) => n+c.combinedFound.filter(id=>c.expected.includes(id)).length,0), missed: cases.reduce((n,c) => n+c.missed.length,0), unexpected: cases.reduce((n,c) => n+c.unexpected.length,0) },
    scale: { chapters:5000, sourceChars:large.chapters.reduce((n,c)=>n+c.content.length,0), elapsedMs:+(performance.now()-start).toFixed(3), found:references.map(r=>r.source.id) } };
  console.log(JSON.stringify(output, null, 2));
  if (output.summary.missed || output.summary.unexpected || output.scale.found.join(",") !== "scale-8") process.exitCode = 1;
} finally { await server.close(); }
