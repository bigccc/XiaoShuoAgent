import { randomUUID } from "node:crypto";
import type { GenerationKind, GenerationPreview, GenerationDelta, GenerationPreviewSnapshot, PreviewPart } from "../shared/generation-preview";

type Frame = { kind: "object" | "array"; path: (string | number)[]; state: "key" | "colon" | "value" | "comma"; key?: string; index: number; seen: Set<string>; afterComma: boolean };
/** A preview-only lexer. It never authorizes or repairs the final response. */
export class IncrementalPreviewJson {
  private stack: Frame[] = [];
  private started = false;
  private done = false;
  private invalid = false;
  private size = 0;
  private values = new Map<string, string>();
  private token?: { kind: "key" | "string" | "primitive"; path: (string | number)[]; text: string; escape: boolean; unicode: string | null; high: string };
  constructor(private mode: GenerationKind) {}
  private fail() { this.invalid = true; this.values.clear(); }
  private allowed(path: (string | number)[]) {
    if (this.mode === "writing") return path.length === 1 && path[0] === "content";
    return path.length === 1 && path[0] === "message" ||
      path.length === 3 && typeof path[1] === "number" && (path[0] === "chapters" || path[0] === "artifacts") && path[2] === "content" ||
      path.length === 5 && path[0] === "artifacts" && typeof path[1] === "number" && path[2] === "blocks" && typeof path[3] === "number" && path[4] === "text";
  }
  private path() {
    const top = this.stack.at(-1)!;
    return [...top.path, top.kind === "array" ? top.index : top.key!];
  }
  private finishValue() {
    const top = this.stack.at(-1);
    if (!top) { this.done = true; return; }
    top.state = "comma"; top.afterComma = false;
  }
  private append(c: string) {
    const t = this.token!;
    if (t.high) {
      if (/^[\uDC00-\uDFFF]$/.test(c)) { t.text += t.high + c; t.high = ""; }
      else { this.fail(); return; }
    } else if (/^[\uD800-\uDBFF]$/.test(c)) t.high = c;
    else if (/^[\uDC00-\uDFFF]$/.test(c)) { this.fail(); return; }
    else t.text += c;
    if (t.kind === "string" && this.allowed(t.path)) this.values.set(t.path.join("."), t.text);
  }
  feed(chunk: string) {
    this.size += chunk.length;
    if (this.size > 1_000_000) this.fail();
    if (this.invalid) return;
    for (let i = 0; i < chunk.length && !this.invalid; i++) {
      const c = chunk[i], t = this.token;
      if (t?.kind === "primitive") {
        if (/[\s,}\]]/.test(c)) {
          try { const value = JSON.parse(t.text); if (value !== null && typeof value === "object") throw Error(); }
          catch { this.fail(); break; }
          this.token = undefined; this.finishValue(); i--; continue;
        }
        t.text += c; continue;
      }
      if (t) {
        if (t.unicode !== null) {
          if (!/[\da-fA-F]/.test(c)) { this.fail(); break; }
          t.unicode += c;
          if (t.unicode.length === 4) { const decoded = String.fromCharCode(parseInt(t.unicode, 16)); t.unicode = null; this.append(decoded); }
        } else if (t.escape) {
          t.escape = false;
          if (c === "u") t.unicode = "";
          else {
            const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
            if (!(c in escapes)) { this.fail(); break; }
            this.append(escapes[c]);
          }
        } else if (c === "\\") t.escape = true;
        else if (c === '"') {
          if (t.high) { this.fail(); break; }
          this.token = undefined;
          if (t.kind === "key") {
            const top = this.stack.at(-1)!;
            if (top.seen.has(t.text)) { this.fail(); break; }
            top.seen.add(t.text); top.key = t.text; top.state = "colon";
          } else this.finishValue();
        } else if (c.charCodeAt(0) < 32) this.fail();
        else this.append(c);
        continue;
      }
      if (/\s/.test(c)) continue;
      if (this.done) { this.fail(); break; }
      const top = this.stack.at(-1);
      if (!this.started) {
        if (c !== "{") { this.fail(); break; }
        this.started = true; this.stack.push({kind:"object", path:[],state:"key",index:0,seen:new Set(),afterComma:false}); continue;
      }
      if (!top) { this.fail(); break; }
      if ((c === "}" && top.kind === "object") || (c === "]" && top.kind === "array")) {
        if (top.afterComma || !(top.state === "comma" || top.state === (top.kind === "object" ? "key" : "value"))) { this.fail(); break; }
        this.stack.pop(); this.finishValue(); continue;
      }
      if (top.state === "comma") {
        if (c !== ",") { this.fail(); break; }
        top.state = top.kind === "object" ? "key" : "value"; top.index++; top.afterComma = true; continue;
      }
      if (top.state === "colon") {
        if (c !== ":") { this.fail(); break; }
        top.state = "value"; continue;
      }
      if (top.state === "key") {
        if (c !== '"') { this.fail(); break; }
        this.token = {kind:"key",path:[],text:"",escape:false,unicode:null,high:""}; continue;
      }
      const path = this.path();
      if (c === "{" || c === "[") {
        if (this.stack.length >= 64) { this.fail(); break; }
        this.stack.push({kind:c==="{"?"object":"array",path,state:c==="{"?"key":"value",index:0,seen:new Set(),afterComma:false});
      } else if (c === '"') {
        this.token = {kind:"string",path,text:"",escape:false,unicode:null,high:""};
        if (this.allowed(path)) this.values.set(path.join("."), "");
      } else if (/[\d\-tfn]/.test(c)) this.token = {kind:"primitive",path,text:c,escape:false,unicode:null,high:""};
      else this.fail();
    }
  }
  parts(): PreviewPart[] {
    const entries = [...this.values];
    return entries.filter(([path]) => !/^artifacts\.\d+\.blocks\./.test(path) || !this.values.has(path.split(".").slice(0,2).join(".")+".content")).map(([path,text])=>({path,text}));
  }
}

type Identity = Pick<GenerationPreview,"projectId"|"taskId"|"kind"|"phase">;
export interface PreviewSession { attemptId: string; feed(chunk: string): void; complete(): void; cancel(): void }
/** In-memory only. No token event changes manuscript persistence or task revisions. */
export class GenerationPreviewService {
  private revision = 0;
  private listeners = new Set<(event: GenerationDelta) => void>();
  private sessions = new Map<string, { value: GenerationPreview; cancel():void; complete():void }>();
  private completed = new Map<string, GenerationPreview>();
  subscribe(listener: (event: GenerationDelta) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  snapshot(projectId: string, acknowledged?: string): GenerationPreviewSnapshot {
    if(acknowledged && this.completed.get(acknowledged)?.projectId===projectId) {
      this.completed.delete(acknowledged);
      for(const [key,session] of this.sessions) if(session.value.attemptId===acknowledged&&session.value.completed)this.sessions.delete(key);
    }
    const all=new Map([...this.completed.values(),...Array.from(this.sessions.values(),s=>s.value)].filter(p=>p.projectId===projectId).map(p=>[p.attemptId,p]));
    return {revision:this.revision,previews:structuredClone([...all.values()])};
  }
  begin(identity: Identity, secrets: string[] = [], display = true): PreviewSession {
    const key = `${identity.kind}:${identity.taskId}`;
    this.sessions.get(key)?.cancel();
    const value: GenerationPreview = {...identity,attemptId:randomUUID(),sequence:0,parts:[],completed:false};
    const parser = new IncrementalPreviewJson(identity.kind);
    let active = true, first = true, timer: ReturnType<typeof setTimeout> | undefined;
    const known = [...new Set(secrets.filter(Boolean))].sort((a,b)=>b.length-a.length);
    const emit = (event: Omit<GenerationDelta, keyof GenerationPreview> & Record<string,unknown>) => {
      value.sequence = ++this.revision;
      const { parts: _parts, completed: _completed, ...meta } = value;
      const result = {...meta,...event} as GenerationDelta;
      for (const listener of this.listeners) { try { listener(result); } catch { /* A detached renderer cannot fail writing. */ } }
    };
    const safe = (text: string, final: boolean) => {
      let result = text;
      for (const secret of known) result = result.replaceAll(secret,"[已隐藏]");
      if (!final) {
        let hold = 0;
        for (const secret of known) for(let n=1;n<secret.length&&n<=result.length;n++) if(result.endsWith(secret.slice(0,n))) hold=Math.max(hold,n);
        if(hold) result=result.slice(0,-hold);
      }
      return result;
    };
    const flush = (final = false) => {
      clearTimeout(timer); timer=undefined;
      if (!active) return;
      const parts = display ? parser.parts().map(p=>({...p,text:safe(p.text,final)})) : [];
      if (value.parts.some(p=>!parts.some(n=>n.path===p.path&&n.text.startsWith(p.text)))) {
        value.parts = parts; emit({op:"reset",parts:structuredClone(parts)}); first=parts.every(p=>!p.text); return;
      }
      for(const p of parts) {
        const old=value.parts.find(n=>n.path===p.path);
        const delta=p.text.slice(old?.text.length??0);
        if(!old) value.parts.push({...p}); else old.text=p.text;
        if(delta) { emit({op:"append",path:p.path,text:delta}); first=false; }
      }
    };
    const cancel = () => {
      if(!active)return; active=false; clearTimeout(timer);
      if(this.sessions.get(key)?.value.attemptId===value.attemptId)this.sessions.delete(key);
      emit({op:"end",outcome:"cancelled"});
    };
    const complete = () => {
      if(!active)return; flush(true); value.completed=true; active=false;
      this.completed.set(value.attemptId,structuredClone(value));
      if(this.sessions.get(key)?.value.attemptId===value.attemptId)this.sessions.delete(key);
      emit({op:"end",outcome:"completed"});
      // Bound abandoned renderer acknowledgements without retaining historical tasks.
      while(this.completed.size>32)this.completed.delete(this.completed.keys().next().value!);
    };
    this.sessions.set(key,{value,cancel,complete}); emit({op:"reset",parts:[]});
    return {attemptId:value.attemptId,feed:(chunk)=>{if(!active)return;parser.feed(chunk);if(first)flush();else if(!timer)timer=setTimeout(()=>flush(),50);},complete,cancel};
  }
  finish(kind:GenerationKind, taskId:string, outcome:"completed"|"cancelled") { const s=this.sessions.get(`${kind}:${taskId}`); if(outcome==="completed")s?.complete();else s?.cancel(); }
  dispose() { for(const s of [...this.sessions.values()])s.cancel();this.completed.clear();this.listeners.clear();this.sessions.clear(); }
}
