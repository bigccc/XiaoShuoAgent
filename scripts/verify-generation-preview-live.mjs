// Opt-in real-provider acceptance. Never import or auto-run from package scripts.
import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const executablePath = process.env.NOVEL_PACKAGED_EXECUTABLE;
if (!executablePath) throw Error('NOVEL_PACKAGED_EXECUTABLE must point to the isolated DMG-copied app');
const reportPath = resolve('docs/generation-preview-live-20261017.json');
let previous;
try { previous=JSON.parse(await readFile(reportPath,'utf8')); } catch {}
if(previous?.outcome==='passed')throw Error('This acceptance already passed; do not repeat paid requests');
const runStarted=Date.now();
const renewed=process.env.NOVEL_PREVIEW_RENEW_WINDOW==='1';
const started=renewed ? runStarted : previous?.calls?.length ? Date.parse(previous.budgetStartedAt ?? previous.startedAt) : runStarted;
const windowMs=renewed ? 10*60_000 : previous?.limits?.milliseconds ?? 20*60_000;
const maxRequests=Number(process.env.NOVEL_PREVIEW_MAX_REQUESTS ?? previous?.limits?.requests ?? 20);
if(!Number.isSafeInteger(maxRequests)||maxRequests>25||maxRequests<Math.max(1,previous?.calls?.length??0))throw Error('Invalid cumulative request limit');
const deadline=started+windowMs;
const limits = { requests: maxRequests, tokens: 300000, milliseconds: windowMs };
const successfulHistory=process.env.NOVEL_PREVIEW_HISTORY_FILE ? JSON.parse(await readFile(process.env.NOVEL_PREVIEW_HISTORY_FILE,'utf8')) : previous;
const report = { startedAt: new Date(runStarted).toISOString(), budgetStartedAt:new Date(started).toISOString(), limits, installedExecutable: executablePath, renewedWindow:renewed, priorWindowLimitReached:previous?.limitReached??null, calls: previous?.calls ?? [], stages: [], preview: [], limitReached: null, outcome: 'incomplete' };
let charged = previous?.tokensChargedIncludingUnknownReservations ?? 0, app, server, page, projectId, profiles = [], stopped = false, step = 'launch';
const dir = process.env.NOVEL_PREVIEW_RESUME_DIR ?? await mkdtemp(join(tmpdir(), 'novel-live-preview-'));
if(!resolve(dir).startsWith(resolve(tmpdir())+'/novel-live-preview-'))throw Error('Invalid isolated resume directory');
const inFlight = new Set();
function enforce(reason) { report.limitReached ??= reason; stopped = true; for (const controller of inFlight) controller.abort(); }
const timer = setTimeout(() => enforce('time'), Math.max(0,deadline-Date.now()));
async function metadata() {
  return page.evaluate(async () => {
    const s = await window.novel.snapshot();
    return {
      conversations: s.conversations.map(t => ({ id: t.id, status: t.status, calls: t.attempts?.length ?? 0 })),
      writingJobs: s.writingJobs.map(j => ({ id: j.id, status: j.status, phase: j.phase, calls: j.calls,
        saved: j.chapters.filter(c => c.savedRevision).length, checked: j.chapters.filter(c => c.checkedRevision).length,
        failureKind: !j.error ? null : String(j.error).includes('单次输出上限') ? 'OUTPUT_LIMIT' : /JSON|格式|字段/.test(j.error) ? 'RESPONSE_FORMAT' : /版本|发生变化|已改变/.test(j.error) ? 'SOURCE_CONFLICT' : /密钥|鉴权/.test(j.error) ? 'AUTH' : /网络|超时|连接/.test(j.error) ? 'NETWORK' : 'OTHER',
        needsReview: j.chapters.filter(c=>c.status==='needs-review').length, issues:j.issues.length, blockingIssues:j.issues.filter(i=>i.impact==='blocking').length })),
      chapters: await Promise.all(s.chapters.sort((a,b)=>a.ordinal-b.ordinal).map(async c => ({ id: c.id, ordinal: c.ordinal, characters: c.content.length, revision: c.revision,
        contentSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(c.content)))).map(n=>n.toString(16).padStart(2,'0')).join('') }))),
    };
  });
}
async function cancelActive() {
  if (!page || !projectId) return;
  await page.evaluate(async () => {
    const s = await window.novel.snapshot();
    for (const j of s.writingJobs.filter(j => j.status === 'running'))
      await window.novel.invoke({ type: 'writing.cancel', id: j.id });
    for (const t of s.conversations.filter(t => t.status === 'running'))
      await window.novel.invoke({ type: 'conversation.cancel', id: t.id });
  }).catch(() => {});
}
async function awaitStopped(kind) {
  while (!stopped && Date.now() < deadline) {
    const state = await metadata();
    const items = kind === 'writing' ? state.writingJobs : state.conversations;
    if (items.length && !items.some(x => x.status === 'running')) return state;
    await new Promise(r => setTimeout(r, 250));
  }
  enforce(report.limitReached ?? 'time');
  await cancelActive();
  return metadata();
}
async function invoke(command) {
  if (stopped) throw Error('Acceptance limit reached');
  const result = await page.evaluate(c => window.novel.invoke(c), command);
  if (!result.ok) throw Error(`Isolated command failed: ${command.type}`);
  return result;
}
try {
  app = await electron.launch({ executablePath, args: [], env: { ...process.env, NOVEL_TEST: '1', NOVEL_DATA_DIR: dir } });
  page = await app.firstWindow();
  await page.waitForLoadState();
  // Only these two production tables are read. The production database is opened read-only.
  step = 'read-protected-profiles';
  profiles = await app.evaluate(async ({ safeStorage }, dbPath) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    if (!safeStorage.isEncryptionAvailable()) throw Error('Real safeStorage unavailable');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT json FROM profiles').all().map(r => JSON.parse(r.json));
      return ['writing', 'checking'].map(purpose => {
        const p = rows.find(p => p.purpose === purpose);
        if (!p) throw Error('Required profile unavailable');
        const credential = db.prepare('SELECT ciphertext FROM credentials WHERE profile_id=?').get(p.id);
        if (!credential) throw Error('Required encrypted credential unavailable');
        if (new URL(p.baseUrl).hostname !== 'api.deepseek.com') throw Error('Upstream must be official api.deepseek.com');
        return { purpose, model: p.model, baseUrl: p.baseUrl, apiKey: safeStorage.decryptString(Buffer.from(credential.ciphertext)) };
      });
    } finally { db.close(); }
  }, join(homedir(), 'Library/Application Support/小说工坊/works.sqlite'));
  if(process.env.NOVEL_PREVIEW_WRITING_FROM_CHECKING==='1') {
    const source=profiles.find(p=>p.purpose==='checking');
    const writing=profiles.find(p=>p.purpose==='writing');
    writing.model=source.model;writing.baseUrl=source.baseUrl;writing.apiKey=source.apiKey;
    report.writingModelSelection={source:'existing checking profile',model:source.model,isolatedOnly:true};
  }
  report.models = profiles.map(({ purpose, model, baseUrl }) => ({ purpose, model, host: new URL(baseUrl).hostname }));
  server = createServer(async (req, res) => {
    const controller = new AbortController();
    inFlight.add(controller);
    let record;
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      // The localhost route bypasses hostname-scoped provider options. Restore
      // exactly the options these JSON-only runner calls use on the official host.
      if(['deepseek-flash','deepseek-v4-pro'].includes(body.model)) {
        body.thinking={type:'disabled'};
        body.response_format={type:'json_object'};
      }
      const profile = profiles.find(p => req.url.startsWith(`/${p.purpose}/`));
      if (!profile || body.model !== profile.model) throw Error('Profile route mismatch');
      const outputReserve = Number(body.max_tokens ?? body.max_completion_tokens);
      if (!Number.isFinite(outputReserve) || outputReserve <= 0) throw Error('Missing output reservation');
      const reservation = Math.ceil(JSON.stringify(body.messages ?? []).length * 1.2) + outputReserve;
      if (stopped || Date.now() >= deadline) { enforce('time'); throw Error('Limit'); }
      if (report.calls.length >= limits.requests) { enforce('requests'); throw Error('Limit'); }
      if (charged + reservation > limits.tokens) { enforce('tokens'); throw Error('Limit'); }
      charged += reservation;
      const phase=['规划','生成','修订','检查','跨章复核','检查整理','定点修正'].find(p=>String(body.messages?.[0]?.content).startsWith(`连续写作·${p}。`)) ?? 'conversation-or-sync';
      record = {phase, index: report.calls.length + 1, purpose: profile.purpose, model: profile.model, startedAt: Date.now(), reservation, usage: null, firstContentAt: null, finishedAt: null, httpStatus: null };
      report.calls.push(record);
      const suffix = req.url.slice(`/${profile.purpose}`.length);
      const upstream = new URL(profile.baseUrl.replace(/\/$/, '') + suffix.replace(/^\/v1/, ''));
      if (upstream.hostname !== 'api.deepseek.com') throw Error('Unexpected upstream');
      const response = await fetch(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization ?? `Bearer ${profile.apiKey}` }, body: JSON.stringify(body), signal: controller.signal });
      record.httpStatus = response.status;
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      res.writeHead(response.status, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.flushHeaders();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const decoder = new TextDecoder();
      let pending = '';
      const observe = value => {
        const choice = value.choices?.[0];
        if(choice?.finish_reason)record.finishReason=choice.finish_reason;
        if ((choice?.delta?.content || choice?.message?.content) && !record.firstContentAt) record.firstContentAt = Date.now();
        if (value.usage && Number.isFinite(value.usage.total_tokens)) record.usage = { totalTokens: value.usage.total_tokens, inputTokens: value.usage.prompt_tokens ?? null, outputTokens: value.usage.completion_tokens ?? null };
      };
      // Forward each upstream chunk before parsing metadata. Never clone or pre-read a response.
      for await (const part of response.body) {
        res.write(part);
        if (contentType.includes('text/event-stream')) {
          pending += decoder.decode(part, { stream: true });
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
            if (line.startsWith('data:') && line.slice(5).trim() !== '[DONE]') {
              try { observe(JSON.parse(line.slice(5))); } catch { /* Partial/other metadata ignored. */ }
            }
          }
          // Bound malformed-line metadata buffering; no response bodies are saved.
          if (pending.length > 2_000_000) pending = '';
        }
      }
      res.end();
      if (record.usage) charged += record.usage.totalTokens - reservation;
      record.finishedAt = Date.now();
    } catch {
      if (record) { record.finishedAt = Date.now(); record.failed = true; }
      if (!res.headersSent) res.writeHead(stopped ? 429 : 502);
      res.end();
    } finally { inFlight.delete(controller); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ids = {};
  const resume=!!process.env.NOVEL_PREVIEW_RESUME_DIR;
  const existingProfiles=resume ? await page.evaluate(async()=> (await window.novel.snapshot()).profiles.map(p=>({id:p.id,revision:p.revision,purpose:p.purpose}))) : [];
  for (const p of profiles) {
    const old=existingProfiles.find(v=>v.purpose===p.purpose);
    const result = await invoke({ type: 'profile.save', ...(old?{id:old.id,revision:old.revision}:{}), name: `隔离验收 ${p.purpose}`, purpose: p.purpose, model: p.model, apiKey: p.apiKey, baseUrl: `http://127.0.0.1:${port}/${p.purpose}/v1` });
    ids[p.purpose] = result.entityId;
  }
  if(resume)projectId=await page.evaluate(async()=> (await window.novel.snapshot()).projects[0].id);
  else {const created=await invoke({type:'project.create',title:'隔离流式验收',chapterWords:200,background:'现代小城修理铺。年轻修理工收到一台留有旧录音的收音机，围绕修复和邻里互助展开，无超自然力量。'});projectId=created.entityId;}
  await page.getByRole('button',{name:/^打开 /}).first().click();
  // The renderer stores identifiers, timestamps and character counts only.
  await page.evaluate(() => {
    window.__livePreviewEvidence = [];
    window.__livePreviewCounts = {};
    const first = new Map(), seen = new Set();
    window.novel.onGenerationDelta(event => {
      if(event.op === 'append') { const count=window.__livePreviewCounts[event.attemptId]??={events:0,characters:0}; count.events++;count.characters+=event.text.length; }
      if (event.op === 'append' && !seen.has(event.attemptId) && !first.has(event.attemptId)) first.set(event.attemptId, { taskId: event.taskId, attemptId: event.attemptId, kind: event.kind, appendAt: Date.now(), path: event.path });
    });
    function frame() {
      for (const [id, value] of first) {
        const region = [...document.querySelectorAll('[aria-label="生成预览"]')].find(n => n.dataset.attemptId === id);
        const bounds = region?.getBoundingClientRect();
        if (region && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth && [...region.querySelectorAll('[data-path] > div')].some(n => n.textContent.length > 0)) {
          window.__livePreviewEvidence.push({ ...value, visibleAt: Date.now(), appendToVisibleMs: Date.now() - value.appendAt });
          first.delete(id);
          seen.add(id);
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  const reuseCases=(successfulHistory?.reusedSuccessfulCases?.length ? successfulHistory.reusedSuccessfulCases : successfulHistory?.stages)?.filter(s=>['planning','trial'].includes(s.name)&&s.state.conversations.at(-1)?.status==='completed'&&(s.name!=='trial'||s.state.chapters.length===1))??[];
  report.reusedSuccessfulCases=reuseCases.map(s=>({name:s.name,state:s.state}));
  const preparedContinuousFixture=reuseCases.length===2;
  for (const [name, text] of (preparedContinuousFixture?[]:[
    ['planning', '先讨论故事规划，给出简短建议，这轮不要试写正文。'],
    ['trial', '请直接试写第一章开篇，约200字，保存为第一章，只写这一章，不继续后续章节。'],
  ])) {
    step = name;
    await invoke({ type: 'conversation.send', projectId, profileId: ids.writing, text, tokenBudget: 100000, stage: name === 'trial' ? 'writing' : 'overview' });
    const state = await awaitStopped('conversation');
    report.stages.push({ name, state });
    if (stopped || state.conversations.at(-1)?.status !== 'completed') throw Error('Conversation acceptance incomplete');
    if (name === 'trial' && state.chapters.length !== 1) throw Error('Trial did not persist exactly one chapter');
  }
  if(preparedContinuousFixture&&!resume){
    const chapter=await invoke({type:'chapter.create',projectId,ordinal:1,title:'修理铺的早晨'});
    await invoke({type:'chapter.save',id:chapter.entityId,revision:chapter.revision??1,content:'年轻修理工林舟打开修理铺的门，将一台留有旧录音的收音机放在工作台上。邻居周叔请他修好机器。今天的目标是排查故障，录音还没有被播放。'});
    report.preparedContinuousFixture=true;
  }
  step = 'continuous-two-chapters';
  if(resume){
    const old=await page.evaluate(async()=> (await window.novel.snapshot()).writingJobs.at(-1));
    await invoke({type:'writing.resume',id:old.id,tokenBudget:200000});
    report.resumedExistingTask=true;
  } else await invoke({ type: 'writing.start', projectId, profileId: ids.writing, text: '接着写两章，每章约200字，沿用已有设定。可省略可选的scenes和states辅助资料，仍按各阶段要求的JSON结构返回。', goal: { kind: 'append', startOrdinal: 2, endOrdinal: 3 }, tokenBudget: 200000, mode: 'thorough' });
  const final = await awaitStopped('writing');
  report.stages.push({ name: 'continuous-two-chapters', state: final });
  report.preview = [...(preparedContinuousFixture ? (successfulHistory?.preview??[]).filter(p=>p.kind==='conversation') : []), ...await page.evaluate(() => (window.__livePreviewEvidence ?? []).map(item=>({...item,...window.__livePreviewCounts[item.attemptId]})))];
  // Call/preview correlation uses ordered time windows; no model text is retained.
  for (const item of report.preview) {
    const call = report.calls.findLast(c => c.firstContentAt && c.firstContentAt <= item.appendAt && (!c.finishedAt || c.finishedAt >= item.appendAt));
    if (call) { item.requestIndex = call.index; item.upstreamToVisibleMs = item.visibleAt - call.firstContentAt; item.visibleBeforeResponseEnd = !!call.finishedAt && item.visibleAt < call.finishedAt; }
  }
  await app.close();
  app = await electron.launch({ executablePath, args: [], env: { ...process.env, NOVEL_TEST: '1', NOVEL_DATA_DIR: dir } });
  page = await app.firstWindow();
  await page.waitForLoadState();
  await page.getByRole('button', { name: /^打开 / }).first().click();
  report.coldRestart = true;
  report.reopened = await metadata();
  const persisted = JSON.stringify(report.reopened.chapters) === JSON.stringify(final.chapters);
  report.reopenMatchesSaved = persisted;
  report.outcome = persisted && !stopped && final.writingJobs.at(-1)?.status === 'completed' && final.chapters.length === 3 && final.writingJobs.at(-1)?.saved === 2 && final.writingJobs.at(-1)?.checked === 2 && final.writingJobs.at(-1)?.blockingIssues === 0 && final.writingJobs.at(-1)?.needsReview === 0 && report.preview.some(p => p.kind === 'writing' && p.visibleBeforeResponseEnd && p.events > 1) && report.preview.some(p => p.kind === 'conversation' && p.visibleBeforeResponseEnd && p.events > 1) ? 'passed' : 'incomplete';
} catch {
  report.failureStage = step;
  // Deliberately avoid error bodies, URLs with secrets, or provider responses.
  report.failure = 'Acceptance did not complete; inspect metadata stage and call statuses';
} finally {
  clearTimeout(timer);
  await cancelActive();
  for (const controller of inFlight) controller.abort();
  if (page) report.preview = report.preview.length ? report.preview : await page.evaluate(() => window.__livePreviewEvidence ?? []).catch(() => []);
  await app?.close().catch(() => {});
  server?.closeAllConnections();
  if (server) await new Promise(r => server.close(r));
  for (const p of profiles) p.apiKey = '';
  profiles = [];
  if(report.outcome==='passed'||!process.env.NOVEL_PREVIEW_KEEP_FAILED||report.limitReached) {await rm(dir,{recursive:true,force:true});report.isolationRemoved=true;} else {report.isolationRemoved=false;report.isolatedDirectory=dir;}
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - runStarted;
  report.budgetElapsedMs = Date.now() - started;
  report.proxyOfficialOptionsRestored=true;
  report.tokensChargedIncludingUnknownReservations = charged;
  await mkdir(resolve('docs'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: report.outcome, calls: report.calls.length, tokensCharged: charged, reportPath }));
  if (report.outcome !== 'passed') process.exitCode = 1;
}
