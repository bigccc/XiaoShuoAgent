import { CostSummary } from "./billing";
import {useEffect,useRef,useState} from "react";
import type {AppState,Chapter,Command} from "../shared/types";
import type {SceneCardDraft,ScenePlan,SceneWorkspace} from "../shared/scenes";
import type {Run} from "./api";
import {useManualGuard,type Flush,type Register} from "./editing";
interface Editor {id?:string;revision?:number;targetWords:number;cards:SceneCardDraft[];quote:string}
const blankCard=(title:string,words:number):SceneCardDraft=>({title,pov:"",goal:"",obstacle:"",turn:"",reveal:"",words,hook:""});
const initial=(target:number):Editor=>({targetWords:target,cards:[blankCard("场景1",Math.floor(target/2)),blankCard("场景2",target-Math.floor(target/2))],quote:""});
const fromPlan=(p:ScenePlan):Editor=>({id:p.id,revision:p.revision,targetWords:p.targetWords,cards:p.cards,quote:""});
const labels={title:"标题",pov:"视角",goal:"目标",obstacle:"阻力",turn:"转折",reveal:"信息揭示",hook:"钩子"};
function readDraft(key:string){try{return localStorage.getItem(key)??"";}catch{return "";}}
function keepDraft(key:string,value:string){try{localStorage.setItem(key,value);}catch{}}
const names={running:"正在规划",paused:"已暂停",failed:"规划未完成",interrupted:"等待手动继续",cancelled:"已取消",completed:"计划已保存","awaiting-author":"需要作者决定"};
export function ScenePanel({state,chapter,run,register,flush,flushChapter}:{state:AppState;chapter:Chapter;run:Run;register:Register;flush:Flush;flushChapter:Flush}){
  const target=Math.min(16000,state.projects.find(p=>p.id===chapter.projectId)?.chapterWords??3000);
  const [data,setData]=useState<SceneWorkspace>(),[editor,setEditor]=useState<Editor>(()=>initial(target));
  const [pending,setPending]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[history,setHistory]=useState<ScenePlan>();
  const [cardIndex,setCardIndex]=useState(0),[matches,setMatches]=useState<SceneCardDraft["anchor"][]>([]),[matchIndex,setMatchIndex]=useState(0);
  const [budget]=useState(100000),[direction,setDirection]=useState("补足目标与阻力"),[request,setRequest]=useState(()=>readDraft(`scene-request:${chapter.id}`)),[decision,setDecision]=useState(()=>readDraft(`scene-decision:${chapter.id}`));
  const sequence=useRef(0),dirty=useRef(false);
  useEffect(()=>keepDraft(`scene-request:${chapter.id}`,request),[chapter.id,request]);
  useEffect(()=>keepDraft(`scene-decision:${chapter.id}`,decision),[chapter.id,decision]);
  const total=editor.cards.reduce((n,c)=>n+c.words,0);
  const canSave=total===editor.targetWords&&editor.cards.length>=2&&editor.cards.length<=4&&!editor.quote&&editor.cards.every(c=>c.title.trim()&&c.words>0);
  async function refresh(){const seq=++sequence.current;try{const next=await window.novel.sceneWorkspace(chapter.id);if(seq!==sequence.current)return;setData(next);if(!dirty.current){const value=next.plan?fromPlan(next.plan):initial(target);setEditor(value);guard.markSaved(value);}}catch(e){setError(e instanceof Error?e.message:"场景计划未读取");}}
  async function save(){setPending(true);setError("");try{if(!canSave)throw Error("请先绑定或清空待定位原文，并检查场景字数合计。");if(!(await flushChapter()))throw Error("正文尚未保存，请先处理正文保存状态。");const result=await run({type:"scene.save",projectId:chapter.projectId,chapterId:chapter.id,...(editor.id?{id:editor.id,revision:editor.revision!}:{}),targetWords:editor.targetWords,cards:editor.cards});const value=fromPlan(await window.novel.scenePlan(result.entityId));setEditor(value);guard.markSaved(value);dirty.current=false;setMatches([]);setNotice("场景计划已保存；它是写作方向，不是已发生事实。");await refresh();}finally{setPending(false);}}
  const guard=useManualGuard(editor,save,register,{canSave,description:"场景卡还有未保存的修改，保存计划后离开，或返回继续编辑。"});
  dirty.current=guard.dirty;
  useEffect(()=>{void refresh();return()=>{sequence.current++;};},[chapter.id,chapter.revision,state]);
  async function action(command:Command,message=""){if(pending)return;setError("");try{if(!(await flush()))return;setPending(true);await run(command);dirty.current=false;setHistory(undefined);await refresh();setNotice(message);}catch(e){setError(e instanceof Error?e.message:"场景操作未完成");}finally{setPending(false);}}
  function updateCard(index:number,field:keyof SceneCardDraft,value:unknown){setEditor(e=>({...e,cards:e.cards.map((c,i)=>i===index?{...c,[field]:value}:c)}));}
  function resize(count:number){setEditor(e=>{const cards=e.cards.slice(0,count);while(cards.length<count)cards.push(blankCard(`场景${cards.length+1}`,1));const base=Math.floor(e.targetWords/count);return{...e,cards:cards.map((c,i)=>({...c,words:base+(i<e.targetWords%count?1:0)}))};});setCardIndex(0);}
  async function locate(){setError("");setMatches([]);try{if(!(await flushChapter()))return;const ch=await window.novel.chapter(chapter.id),quote=editor.quote;if(!quote)throw Error("请输入要修改的连续原文。");const found:NonNullable<SceneCardDraft["anchor"]>[]=[];let start=ch.content.indexOf(quote);while(start>=0&&found.length<100){found.push({chapterId:ch.id,revision:ch.revision,start,end:start+quote.length,quote});start=ch.content.indexOf(quote,start+1);}if(!found.length)throw Error("原文未找到，请核对标点和空白。");setMatches(found);setMatchIndex(0);}catch(e){setError(e instanceof Error?e.message:"定位未完成");}}
  const selected=editor.cards[cardIndex];
  return <section className="card scene-panel" aria-label="本章场景计划">
    <h3>本章场景计划</h3><p>按需调整2—4张卡。增减卡片会重新平均分配预计篇幅；保存计划不改正文。</p>
    {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {data?.needsReview&&<p className="hint warn">场景依据或绑定原文已改变，请复核卡片和原文后保存，或重新规划；旧计划不会继续使用。</p>}
    {!!data?.plan?.sources.length&&<details><summary>场景参考依据</summary><p className="muted">资料版本与正文版本变化后需要复核；计划不作为原文事实。</p>{data.plan.sources.map((s,i)=>{const name=s.kind==="chapter"?state.chapters.find(c=>c.id===s.id)?.title:s.kind==="note"?state.notes.find(n=>n.id===s.id)?.title:state.projects.find(p=>p.id===s.id)?.title;return <p key={i}>{s.kind==="chapter"?"正文":s.kind==="note"?"故事资料":"作品"} · {name??"已移除"} · 版本{s.revision}</p>;})}</details>}
    <form onSubmit={e=>{e.preventDefault();void guard.save().catch(err=>setError(err instanceof Error?err.message:"保存未完成"));}}>
      <fieldset disabled={pending}>
        <label>本章计划字数<input aria-label="本章计划字数" type="number" min={2} max={16000} value={editor.targetWords} onChange={e=>setEditor(v=>({...v,targetWords:Number(e.target.value)}))}/></label>
        <p className={total===editor.targetWords?"muted":"hint warn"}>场景合计{total}字 · 本章计划{editor.targetWords}字</p>
        <div className="scene-cards">{editor.cards.map((card,index)=><article className="scene-card" key={card.id??index}>
          <h4>场景{index+1}</h4>{Object.entries(labels).map(([key,label])=><label key={key}>场景{index+1}{label}<input aria-label={`场景${index+1}${label}`} maxLength={key==="title"?120:400} value={card[key as keyof typeof labels]} onChange={e=>updateCard(index,key as keyof SceneCardDraft,e.target.value)}/></label>)}
          <label>场景{index+1}预计字数<input aria-label={`场景${index+1}预计字数`} type="number" min={1} max={16000} value={card.words} onChange={e=>updateCard(index,"words",Number(e.target.value))}/></label>
          {card.anchor&&<><small>绑定原文 · 版本{card.anchor.revision}</small><blockquote>{card.anchor.quote}</blockquote><button type="button" onClick={()=>updateCard(index,"anchor",undefined)}>移除场景引用</button></>}
        </article>)}</div>
        <div className="toolbar"><button type="button" disabled={editor.cards.length>=4||editor.targetWords<=editor.cards.length} onClick={()=>resize(editor.cards.length+1)}>增加场景卡</button><button type="button" disabled={editor.cards.length<=2} onClick={()=>resize(editor.cards.length-1)}>减少场景卡</button></div>
        <h4>绑定要定向修改的原文</h4>
        <label>绑定到场景<select aria-label="绑定到场景" value={cardIndex} onChange={e=>setCardIndex(Number(e.target.value))}>{editor.cards.map((c,i)=><option key={i} value={i}>场景{i+1} · {c.title}</option>)}</select></label>
        <label>场景引用原文<textarea aria-label="场景引用原文" maxLength={16000} value={editor.quote} onChange={e=>{setEditor(v=>({...v,quote:e.target.value}));setMatches([]);}}/></label>
        <button type="button" onClick={()=>void locate()}>定位场景原文</button>
        {!!matches.length&&<><label>场景原文匹配位置<select aria-label="场景原文匹配位置" value={matchIndex} onChange={e=>setMatchIndex(Number(e.target.value))}>{matches.map((m,i)=><option key={i} value={i}>第{i+1}处 · 位置{m?.start}</option>)}</select></label><button type="button" onClick={()=>{const anchor=matches[matchIndex];setEditor(v=>({...v,quote:"",cards:v.cards.map((c,i)=>i===cardIndex?{...c,anchor}:c)}));setMatches([]);}}>绑定此片段</button></>}
        <button className="primary" disabled={!canSave}>保存场景计划</button>
      </fieldset>
    </form>
    <div className="toolbar"><button disabled={pending} onClick={()=>void action({type:"scene.plan",projectId:chapter.projectId,chapterId:chapter.id,text:"按本章目标规划场景的目标、阻力、转折、视角和篇幅，沿用现有方向",tokenBudget:budget})}>规划本章场景</button>{editor.id&&<button disabled={pending} onClick={()=>void window.novel.scenePlan(editor.id!).then(setHistory).catch(e=>setError(e.message))}>查看场景历史</button>}</div>
    <p className="muted">“规划本章场景”会发起一次AI请求，已有计划与正文保留。</p>
    {history?.history.map(h=><div className="scene-history" key={h.revision}><span>版本{h.revision} · {h.cards.map(c=>c.title).join(" / ")}</span><button disabled={pending} onClick={()=>void action({type:"scene.restore",id:history.id,revision:data?.plan?.revision??history.revision,historyRevision:h.revision})}>恢复场景版本{h.revision}</button></div>)}
    <section className="scene-revision"><h4>定向修订</h4><p>只替换所绑定的原文，段外和标题保留。结果在“待审稿与记录”中比较后采纳。</p>
      <label>场景修订方式<select value={direction} onChange={e=>setDirection(e.target.value)}>{["补足目标与阻力","强化转折","调整视角","删冗余描写","补冲突"].map(d=><option key={d}>{d}</option>)}</select></label>
      <label>本场景修改要求<textarea aria-label="本场景修改要求" maxLength={6000} value={request} onChange={e=>setRequest(e.target.value)} placeholder="说明希望怎样变化，已绑定片段以外的文字不变"/></label>
      <button disabled={pending||!editor.id||!selected?.id||!selected.anchor||!request.trim()||data?.needsReview} onClick={()=>void action({type:"scene.revise",id:editor.id!,revision:editor.revision!,cardId:selected.id!,text:`${direction}：${request}`,tokenBudget:budget},"场景待审稿已建立，请在待审稿与记录中查看")}>生成场景待审稿</button>
    </section>
    <p className="muted">开始前将展示预计花费，可设置本次金额预算。</p>
    {data?.jobs.map(j=><article className="scene-job" key={j.id}><strong>{names[j.status]}</strong><p role="status">{j.reply}</p><CostSummary ownerId={j.id} />{j.warnings.map((w,i)=><p key={i} className="hint warn">{w}</p>)}<details><summary>技术详情 · 场景调用</summary><p>{j.calls}次请求 · 占用{j.budgetUsed}/{j.tokenBudget} Token · {j.usage?.estimated?"含估算或预留":"已报告"}用量</p></details>{j.status==="awaiting-author"&&<label>场景规划决定<textarea maxLength={4000} value={decision} onChange={e=>setDecision(e.target.value)}/></label>}<div className="toolbar">{j.status==="running"&&<button disabled={pending} onClick={()=>void action({type:"scene.pause",id:j.id})}>暂停场景规划</button>}{["paused","failed","interrupted","awaiting-author"].includes(j.status)&&<><button disabled={pending||j.status==="awaiting-author"&&!decision.trim()} onClick={()=>void action({type:"scene.resume",id:j.id,...(j.status==="awaiting-author"&&decision?{text:decision}:{})})}>继续场景规划</button></>}{!["completed","cancelled"].includes(j.status)&&<button disabled={pending} onClick={()=>void action({type:"scene.cancel",id:j.id})}>取消场景规划</button>}</div></article>)}
    {guard.dialog}
  </section>;
}
