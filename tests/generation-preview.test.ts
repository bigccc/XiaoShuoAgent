import { describe, expect, it, vi, afterEach } from "vitest";
import * as preview from "../src/main/generation-preview";

afterEach(() => vi.useRealTimers());
describe("incremental JSON preview", () => {
  it("decodes every split point without exposing internal fields", () => {
    expect(preview.IncrementalPreviewJson).toBeTypeOf("function");
    const raw = JSON.stringify({ message: '你好\n"作者"😀', memory: "私有共识", artifacts: [{ blocks: [{ text: "阶段\\成果" }] }], chapters: [{ content: "正文\t第一段。" }] });
    for (let split = 0; split <= raw.length; split++) {
      const p = new preview.IncrementalPreviewJson("conversation");
      p.feed(raw.slice(0, split)); p.feed(raw.slice(split));
      expect(p.parts()).toEqual([
        { path: "message", text: '你好\n"作者"😀' },
        { path: "artifacts.0.blocks.0.text", text: "阶段\\成果" },
        { path: "chapters.0.content", text: "正文\t第一段。" },
      ]);
    }
  });
  it("shows partial content before closing quote and supports escaped Unicode", () => {
    const p = new preview.IncrementalPreviewJson("writing");
    p.feed('{"majorChange":false,"content":"雨\\u843d\\ud83d');
    expect(p.parts()).toEqual([{path:"content",text:"雨落"}]);
    p.feed('\\ude00\\n窗前。');
    expect(p.parts()).toEqual([{path:"content",text:"雨落😀\n窗前。"}]);
  });
  it("prefers artifact content over blocks and disables malformed or duplicate structure", () => {
    const p = new preview.IncrementalPreviewJson("conversation");
    p.feed('{"artifacts":[{"blocks":[{"text":"重复"}],"content":"完整成果"}]}');
    expect(p.parts()).toEqual([{path:"artifacts.0.content",text:"完整成果"}]);
    p.feed(',"message":"尾随对象外内容"');
    expect(p.parts()).toEqual([]);
    const duplicate = new preview.IncrementalPreviewJson("writing");
    duplicate.feed('{"content":"第一次","content":"第二次"}');
    expect(duplicate.parts()).toEqual([]);
  });
});
describe("generation preview session", () => {
  it("publishes first prose immediately, coalesces next deltas, flushes before completion", () => {
    vi.useFakeTimers();
    const service = new preview.GenerationPreviewService(); const events: any[]=[];
    service.subscribe(e => events.push(e));
    const s = service.begin({projectId:"p",taskId:"t",kind:"writing",phase:"生成"});
    s.feed('{"content":"第一段');
    expect(events.at(-1)).toMatchObject({op:"append",path:"content",text:"第一段"});
    s.feed('第二段'); s.feed('第三段');
    expect(events.filter(e=>e.op==="append")).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(events.at(-1)).toMatchObject({op:"append",text:"第二段第三段"});
    s.feed('末段"}'); s.complete();
    expect(events.at(-2)).toMatchObject({op:"append",text:"末段"});
    expect(events.at(-1)).toMatchObject({op:"end",outcome:"completed"});
    expect(service.snapshot("p").previews[0].parts[0].text).toBe("第一段第二段第三段末段");
    service.dispose();
  });
  it("resets attempts, rejects cancelled late deltas and does not expose cross-chunk keys", () => {
    const service = new preview.GenerationPreviewService(); const events:any[]=[];
    service.subscribe(e=>events.push(e));
    const s=service.begin({projectId:"p",taskId:"t",kind:"conversation",phase:"创作"},["secret-key"]);
    s.feed('{"message":"开头secret-');
    expect(JSON.stringify(events)).not.toContain("secret-");
    s.feed('key结尾"}');s.complete();
    expect(service.snapshot("p").previews[0].parts[0].text).toBe("开头[已隐藏]结尾");
    service.snapshot("p",s.attemptId);
    const retry=service.begin({projectId:"p",taskId:"t",kind:"conversation",phase:"重试"});
    const id=service.snapshot("p").previews[0].attemptId;
    expect(id).not.toBe(s.attemptId);
    retry.cancel(); const count=events.length; retry.feed('{"message":"迟到"}'); s.feed("迟到");
    expect(events).toHaveLength(count); expect(service.snapshot("p").previews).toEqual([]);
    expect(service.snapshot("other").previews).toEqual([]); service.dispose();
  });
});
it("does not confuse dotted keys or numeric object keys with authorized array paths",()=>{
  const p=new preview.IncrementalPreviewJson("conversation");
  p.feed('{"chapters.0.content":"伪装路径","chapters":{"0":{"content":"错误形状"}},"message":"正常回复"}');
  expect(p.parts()).toEqual([{path:"message",text:"正常回复"}]);
});
it("decodes one-character chunks and stops on invalid escapes or excessive nesting",()=>{
  const p=new preview.IncrementalPreviewJson("writing");
  for(const c of '{"content":"雨\\u843d\\ud83d\\ude00\\n窗"}')p.feed(c);
  expect(p.parts()).toEqual([{path:"content",text:"雨落😀\n窗"}]);
  const invalid=new preview.IncrementalPreviewJson("writing");
  invalid.feed('{"content":"可见\\x');expect(invalid.parts()).toEqual([]);
  const deep=new preview.IncrementalPreviewJson("writing");
  deep.feed('{"content":"旧预览","other":'+ '['.repeat(65));expect(deep.parts()).toEqual([]);
});
it("retains completed text in snapshots across stage transitions until acknowledged",()=>{
  const service=new preview.GenerationPreviewService();
  const first=service.begin({projectId:"p",taskId:"t",kind:"writing",phase:"生成"});
  first.feed('{"content":"已生成正文"}');first.complete();
  service.begin({projectId:"p",taskId:"t",kind:"writing",phase:"检查"},[],false);
  expect(service.snapshot("p").previews.find(p=>p.attemptId===first.attemptId)?.parts[0].text).toBe("已生成正文");
  expect(service.snapshot("other",first.attemptId).previews).toEqual([]);
  expect(service.snapshot("p").previews).toHaveLength(2);
  expect(service.snapshot("p",first.attemptId).previews).toHaveLength(1);
  service.dispose();
});
it("bounds abandoned completed previews across distinct tasks",()=>{
  const service=new preview.GenerationPreviewService();
  for(let n=0;n<33;n++) {const s=service.begin({projectId:"p",taskId:String(n),kind:"writing",phase:"生成"});s.feed('{"content":"正文"}');s.complete();}
  expect(service.snapshot("p").previews).toHaveLength(32);service.dispose();
});
