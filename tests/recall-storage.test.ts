import { afterEach, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { ProjectFiles } from "../src/main/files";
import { validateRecallReferences } from "../src/shared/recall";
import { chapter, meta, state } from "./fixtures/recall-cases";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { ConversationTurn } from "../src/shared/types";

const stores: Store[] = [], dirs: string[] = [];
afterEach(()=>{ stores.splice(0).forEach(s=>s.close()); dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})); });
function setup() {
  const dir=mkdtempSync(join(tmpdir(),"recall-storage-")); dirs.push(dir);
  const store=new Store(join(dir,"works.sqlite")); stores.push(store);
  store.put("projects",state([]).projects[0]);
  store.put("chapters",chapter("c8",8,"铜钥匙在老周手里。"));
  const reference={source:{kind:"chapter" as const,id:"c8",revision:1},ordinal:8,title:"c8",start:0,end:9,excerpt:"铜钥匙在老周手里。",matchedTerms:["钥匙"]};
  const turn:ConversationTurn={...meta,id:"turn",projectId:"p",text:"讨论铜钥匙",reply:"已讨论",status:"completed",suggestions:[],chapterIds:[],memory:"",contextWarnings:[],usage:null,contextReferences:[reference]};
  store.put("conversations",turn);
  return {dir,store,turn,reference};
}
it("keeps optional references through restart and remaps their sources in an imported copy",async()=>{
  const {dir,store,turn}=setup();
  const second=new Store(join(dir,"works.sqlite")); stores.push(second);
  expect(second.get("conversations","turn")!.contextReferences).toEqual(turn.contextReferences);
  const file=join(dir,"book.novel"), files=new ProjectFiles(store);
  await files.backup("p",file);
  const imported=await files.importBackup(file);
  const copy=store.selectByProject("conversations",imported)[0];
  expect(copy.contextReferences![0].source.id).not.toBe("c8");
  expect(store.get("chapters",copy.contextReferences![0].source.id)?.projectId).toBe(imported);
  expect(copy.contextReferences![0].excerpt).toBe("铜钥匙在老周手里。");
});
it("rejects cross-project references in recovery data instead of displaying another work's evidence",async()=>{
  const {dir,store}=setup();
  const files=new ProjectFiles(store);
  const file=join(dir,"book.novel"); await files.backup("p",file);
  const pack=JSON.parse(readFileSync(file,"utf8"));
  pack.format="xiaoshuo-recovery";
  pack.payload.schemaVersion=8;
  pack.payload.projects.push({...pack.payload.projects[0],id:"other"});
  pack.payload.chapters.push(chapter("foreign",8,"别人的稿件。",{projectId:"other"}));
  pack.payload.conversations[0].contextReferences[0].source.id="foreign";
  pack.sha256=createHash("sha256").update(JSON.stringify(pack.payload)).digest("hex");
  writeFileSync(file,JSON.stringify(pack));
  await expect(files.importBackup(file)).rejects.toThrow(/引用|作品/);
});
it("permits deleted historical evidence in a backup and accepts old turns with no new field",async()=>{
  const {dir,store,turn}=setup();
  store.remove("chapters","c8");
  const {contextReferences,...legacy}=turn;
  store.put("conversations",{...legacy,id:"legacy"});
  const files=new ProjectFiles(store); const file=join(dir,"deleted.novel");
  await files.backup("p",file);
  const imported=await files.importBackup(file);
  expect(store.selectByProject("conversations",imported)).toHaveLength(2);
  expect(store.selectByProject("conversations",imported).some(t=>t.contextReferences?.[0].excerpt==="铜钥匙在老周手里。")).toBe(true);
});
it("rejects malformed ranges, oversized evidence and duplicate references",()=>{
  const {reference}=setup();
  expect(()=>validateRecallReferences([reference])).not.toThrow();
  for(const bad of [[{...reference,end:10}], [{...reference,excerpt:"甲".repeat(481),end:481}], [reference,reference], [{...reference,source:{...reference.source,kind:"note"}}]])
    expect(()=>validateRecallReferences(bad)).toThrow();
});
