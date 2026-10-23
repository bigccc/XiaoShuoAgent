import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import { detectWritingGoal } from '../shared/writing';
import type { ChatRequest } from './provider';
import { DomainError } from '../shared/validation';
import { billable, costMicros, money, type BillingQuote, type BillingSummary } from '../shared/billing';
import type { ModelProfile, TaskUsage } from '../shared/types';

export class BillingService {
  private scope = new AsyncLocalStorage<string>();
  private tokenGuard = new AsyncLocalStorage<boolean>();
  moneyControlsTokens() { return this.tokenGuard.getStore() === true; }
  private db;
  constructor(private store:Store) {
    this.db=store.billingDatabase();
    if(!this.db.prepare("SELECT name FROM sqlite_master WHERE name='billingBudgets'").get()) {
      if(store.path!==':memory:') store.backup(`${store.path}.before-billing-${Date.now()}.sqlite`);
      store.transaction(()=>this.db.exec(`CREATE TABLE billingBudgets(id TEXT PRIMARY KEY,owner TEXT,project TEXT,budget INTEGER NOT NULL,next INTEGER NOT NULL DEFAULT 0,unknown INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE billingRequests(id TEXT PRIMARY KEY,budget TEXT NOT NULL,profile TEXT NOT NULL,model TEXT NOT NULL,pricing TEXT NOT NULL,phase TEXT NOT NULL,reserved INTEGER NOT NULL,cost INTEGER,status TEXT NOT NULL,usage TEXT,created TEXT NOT NULL);`));
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS billingOwners(owner TEXT PRIMARY KEY,budget TEXT NOT NULL)");
    if(!this.db.prepare("PRAGMA table_info(billingBudgets)").all().some(c=>c.name==='moneyTokens')) this.db.exec("ALTER TABLE billingBudgets ADD COLUMN moneyTokens INTEGER NOT NULL DEFAULT 1");
    // In-flight requests may have reached the service before a crash. Keep reservation.
    this.db.exec("UPDATE billingRequests SET status='unknown' WHERE status='running'");
  }
  private profiles(c:any):ModelProfile[] {
    const all=this.store.list('profiles');

    let saved:any;
    for(const table of ['writingJobs','revisionJobs','conversations','tasks','voiceJobs','sceneJobs','storyJobs','syncJobs'] as const) { if(c.id) saved ||= this.store.get(table,c.id); }
    const purpose=/story\.job|ai\.check/.test(c.type)?'checking':/voice\.|scene\./.test(c.type)?'planning':'writing';
    const last=this.store.list('conversations').filter(t=>t.projectId===c.projectId&&all.some(p=>p.id===t.profileId)).at(-1);
    const writingGoal=c.type==='conversation.send' && typeof c.text==='string' && detectWritingGoal(c.text,Math.max(0,...this.store.chapterMetadata(c.projectId).map(ch=>ch.ordinal)));
    const previous=!writingGoal && /conversation\.send|authoring\.sync/.test(c.type)?last?.profileId:undefined;
    const id=c.profileId??saved?.profileId??saved?.requestSnapshot?.profile?.id??previous;
    const primary=all.find(p=>p.id===id)??all.find(p=>p.purpose===purpose)??(/voice\.|scene\./.test(c.type)?all.find(p=>p.purpose==='writing'):undefined)??all[0];
    const check=all.find(p=>p.id===saved?.checkingProfileId)??all.find(p=>p.purpose==='checking')??primary;
    return [...new Map((/writing\.|conversation\.send/.test(c.type)?[primary,check]:[primary]).filter(Boolean).map(p=>[p!.id,p!])).values()];
  }
  quote(c:any):BillingQuote {
    if(!c||typeof c.type!=='string')throw new DomainError('VALIDATION','请求格式不正确');
    const required=billable(c.type) && (c.type!=='authoring.resolveSync' || c.resolution==='draft'), profiles=required?this.profiles(c):[];
    const missingProfiles=profiles.filter(p=>!p.pricing).map(p=>p.name);
    if(required&&!profiles.length)missingProfiles.push('请先配置 AI 连接');
    let goal=c.goal;
    if(c.type==='conversation.send' && typeof c.text==='string') {
      const last=Math.max(0,...this.store.chapterMetadata(c.projectId).map(ch=>ch.ordinal));
      goal=detectWritingGoal(c.text,last);
    }
    const oldWriting=c.id?this.store.get('writingJobs',c.id):undefined;
    let count=goal?goal.endOrdinal-goal.startOrdinal+1:oldWriting?oldWriting.chapters.filter(ch=>!['checked','needs-review'].includes(ch.status)).length:1;
    if(!Number.isSafeInteger(count)||count<1||count>100)count=1;
    // Includes planning, generation, checking, one local repair/verification and recovery.
    const writing=/writing\.|conversation\.send/.test(c.type);
    const input=48000*4 + (typeof c.text==='string'?c.text.length*1.2:0) + 16000;
    let estimatedMicros=Math.max(0,...profiles.map(p=>p.pricing?costMicros(p.pricing,input,32000):0))*(writing?2+count*6:6);
    estimatedMicros=Math.ceil(estimatedMicros);
    const existing=c.id?this.summary(c.id):undefined;
    const minimumBudgetMicros=existing?existing.spentMicros+existing.reservedMicros:0;
    const budgetMicros=Math.max(existing?.budgetMicros??0,Math.ceil((minimumBudgetMicros+estimatedMicros)/10000)*10000);
    return {required,estimatedMicros,budgetMicros,minimumBudgetMicros,priced:missingProfiles.length===0,missingProfiles};
  }
  private owner(owner:string) { return this.db.prepare('SELECT * FROM billingBudgets WHERE id=(SELECT budget FROM billingOwners WHERE owner=?) OR owner=? ORDER BY rowid DESC LIMIT 1').get(owner,owner) as any; }
  summary(owner:string):BillingSummary {
    const b=this.owner(owner);
    if(!b)return {spentMicros:0,reservedMicros:0,budgetMicros:0,unknown:true};
    const rows=this.db.prepare('SELECT reserved,cost,status FROM billingRequests WHERE budget=?').all(b.id);
    return {spentMicros:rows.reduce((s,r)=>s+Number(r.cost??0),0),reservedMicros:rows.reduce((s,r)=>s+(r.cost==null?Number(r.reserved):0),0),budgetMicros:Number(b.budget),unknown:!!b.unknown||rows.some(r=>r.status==='unknown'),nextMicros:Number(b.next)};
  }
  async dispatch(c:any, run:(c:any)=>Promise<any>) {
    if(!billable(c?.type??'') || c.type==='authoring.resolveSync' && c.resolution!=='draft') { if(c && typeof c==='object') { const {billing,...local}=c; return run(local); } return run(c); }
    const {billing,...clean}=c;
    let moneyControlsTokens = clean.tokenBudget === undefined;
    const quote=this.quote(clean);
    if(!quote.priced)return {ok:false,error:{code:'VALIDATION',message:`请先填写模型的输入、输出价格：${quote.missingProfiles.join('、')}`}};
    let b=clean.id?this.owner(clean.id):undefined;
    if(b) moneyControlsTokens=!!b.moneyTokens;
    const amount=billing?.budgetMicros;
    if(amount!==undefined&&(!Number.isSafeInteger(amount)||amount<0||amount>Number.MAX_SAFE_INTEGER/4))return {ok:false,error:{code:'VALIDATION',message:'本次金额预算不正确'}};
    if(!b&&amount===undefined)return {ok:false,error:{code:'VALIDATION',message:'请先查看预计花费并设置本次金额预算'}};
    if(b&&amount!==undefined) {
      const sum=this.summary(clean.id);
      if(amount<sum.spentMicros+sum.reservedMicros)return {ok:false,error:{code:'VALIDATION',message:'金额预算不能低于已有消耗和预留'}};
      this.db.prepare('UPDATE billingBudgets SET budget=? WHERE id=?').run(amount,b.id);
    }
    if(!b) {
      b={id:randomUUID()};
      this.db.prepare('INSERT INTO billingBudgets(id,owner,project,budget,unknown,moneyTokens) VALUES(?,?,?,?,?,?)').run(b.id,clean.id??b.id,clean.projectId??null,amount,clean.id && ['writingJobs','revisionJobs','conversations','tasks','voiceJobs','sceneJobs','storyJobs','syncJobs'].some(t=>this.store.get(t as any,clean.id)) ? 1 : 0,moneyControlsTokens?1:0);
    }
    // Legacy token allowances are internal guardrails; money authorization controls spending.
    if(clean.tokenBudget===undefined && /^(writing\.|revision\.|ai\.|voice\.|scene\.|structure\.|story\.job\.)/.test(clean.type))clean.tokenBudget= /conversation\.send|writing\.|revision\./.test(clean.type)?1_000_000_000:1_000_000;
    const result=await this.scope.run(b.id,()=>this.tokenGuard.run(moneyControlsTokens,()=>run(clean)));
    if(result.ok&&result.entityId)this.db.prepare('INSERT OR REPLACE INTO billingOwners(owner,budget) VALUES(?,?)').run(result.entityId,b.id);
    return result;
  }
  reserve(r:ChatRequest):string {
    const budget=this.scope.getStore();
    if(!budget)throw new DomainError('CONFLICT','此后台 AI 操作尚未设置金额预算，请手动继续');
    const p=this.store.list('profiles').find(p=>(!r.billingProfileId || p.id===r.billingProfileId) && p.baseUrl.replace(/\/$/,'')===r.baseUrl.replace(/\/$/,'')&&p.model===r.model);
    if(!p?.pricing)throw new DomainError('VALIDATION','请先填写当前模型的输入、输出价格');
    const reserved=costMicros(p.pricing,r.messages.reduce((s,m)=>s+Buffer.byteLength(m.content,'utf8')+64,128),r.maxTokens);
    const id = this.store.transaction(()=>{
      const b=this.db.prepare('SELECT * FROM billingBudgets WHERE id=?').get(budget)!;
      const total=Number(this.db.prepare('SELECT coalesce(sum(coalesce(cost,reserved)),0) AS total FROM billingRequests WHERE budget=?').get(budget)!.total);
      if(total+reserved>Number(b.budget)) {
        this.db.prepare('UPDATE billingBudgets SET next=? WHERE id=?').run(reserved,budget);
        return ''; 
      }
      this.db.prepare('UPDATE billingBudgets SET next=0 WHERE id=?').run(budget);
      const id=randomUUID();
      this.db.prepare('INSERT INTO billingRequests(id,budget,profile,model,pricing,phase,reserved,status,created) VALUES(?,?,?,?,?,?,?,?,?)').run(id,budget,p.id,p.model,JSON.stringify(p.pricing),r.messages[0]?.content.slice(0,100)??'',reserved,'running',new Date().toISOString());
      return id;
    });
    if(!id) { const b=this.db.prepare('SELECT owner FROM billingBudgets WHERE id=?').get(budget)!; const sum=this.summary(String(b.owner)); throw new DomainError('CONFLICT',`本次金额预算不足，已用及预留 ${money(sum.spentMicros+sum.reservedMicros)}，下一步预计 ${money(reserved)}，预算 ${money(sum.budgetMicros)}；进度已保存，请调整金额后继续`); }
    return id;
  }
  settle(id:string,usage?:TaskUsage) {
    const row=this.db.prepare("SELECT * FROM billingRequests WHERE id=? AND status='running'").get(id);
    if(!row)return;
    const known=usage?.inputTokens!=null&&usage?.outputTokens!=null;
    const price=JSON.parse(String(row.pricing));
    this.db.prepare('UPDATE billingRequests SET cost=?,status=?,usage=? WHERE id=?').run(known?costMicros(price,usage!.inputTokens!,usage!.outputTokens!, (usage as any).cachedInputTokens??0):null,known?'settled':'unknown',usage?JSON.stringify(usage):null,id);
  }
}
