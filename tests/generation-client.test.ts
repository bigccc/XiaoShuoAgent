import {expect,it} from "vitest";
import * as client from "../src/renderer/generation-state";
import type {GenerationDelta,GenerationPreviewSnapshot} from "../src/shared/generation-preview";
const base={projectId:"p",taskId:"t",kind:"conversation" as const,attemptId:"a",phase:"创作",sequence:1};
it("merges snapshot and queued deltas idempotently without cross-project or stale attempts",()=>{
  expect(client.applyGenerationDelta).toBeTypeOf("function");
  let s:GenerationPreviewSnapshot={revision:0,previews:[]};
  s=client.applyGenerationDelta(s,{...base,op:"reset",parts:[]},"p");
  const append:GenerationDelta={...base,sequence:2,op:"append",path:"message",text:"第一段"};
  s=client.applyGenerationDelta(s,append,"p");s=client.applyGenerationDelta(s,append,"p");
  expect(s.previews[0].parts).toEqual([{path:"message",text:"第一段"}]);
  s=client.applyGenerationDelta(s,{...base,sequence:3,op:"reset",attemptId:"b",parts:[]},"p");
  s=client.applyGenerationDelta(s,{...base,sequence:4,op:"append",path:"message",text:"旧片段"},"p");
  expect(s.previews[0].parts).toEqual([]);
  s=client.applyGenerationDelta(s,{...base,sequence:5,op:"append",projectId:"other",path:"message",text:"其他作品"},"p");
  expect(s.previews).toHaveLength(1);expect(s.revision).toBe(5);
  s=client.applyGenerationDelta(s,{...base,attemptId:"b",sequence:6,op:"end",outcome:"cancelled"},"p");
  expect(s.previews).toEqual([]);
});
it("retains completed prose during the next phase until saved-state refresh acknowledges it",()=>{
  let s:GenerationPreviewSnapshot={revision:0,previews:[]};
  s=client.applyGenerationDelta(s,{...base,op:"reset",parts:[{path:"content",text:"已生成正文"}]},"p");
  s=client.applyGenerationDelta(s,{...base,sequence:2,op:"end",outcome:"completed"},"p");
  s=client.applyGenerationDelta(s,{...base,sequence:3,attemptId:"check",phase:"检查",op:"reset",parts:[]},"p");
  expect(s.previews.find(p=>p.attemptId==="a")?.parts[0].text).toBe("已生成正文");
  s=client.applyGenerationDelta(s,{...base,sequence:4,attemptId:"check",op:"end",outcome:"cancelled"},"p");
  expect(s.previews).toHaveLength(1);expect(s.previews[0].attemptId).toBe("a");
});
