import {useEffect,useLayoutEffect,useRef,useState} from "react";
import type {GenerationDelta,GenerationPreview,GenerationPreviewSnapshot} from "../shared/generation-preview";
import {applyGenerationDelta} from "./generation-state";

function usePreviews(projectId:string, refresh:()=>Promise<void>){
  const [state,setState]=useState<GenerationPreviewSnapshot>({revision:0,previews:[]});
  const [error,setError]=useState(false);
  const refreshRef=useRef(refresh);refreshRef.current=refresh;
  const syncRef=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let alive=true, current:GenerationPreviewSnapshot={revision:0,previews:[]}, pending=false;
    let queue:GenerationDelta[]=[];
    const settling=new Set<string>();
    const publish=()=>{if(alive)setState(current);};
    const settle=(preview:GenerationPreview)=>{
      if(settling.has(preview.attemptId))return;settling.add(preview.attemptId);
      void refreshRef.current().then(()=>{
        if(!alive)return;
        void window.novel.generationPreview(projectId,preview.attemptId).catch(()=>{});
        current={...current,previews:current.previews.filter(p=>p.attemptId!==preview.attemptId)};publish();
      }).catch(()=>{if(alive)setError(true);}).finally(()=>settling.delete(preview.attemptId));
    };
    const apply=(event:GenerationDelta)=>{
      current=applyGenerationDelta(current,event,projectId);
      for(const p of current.previews)if(p.completed)settle(p);
    };
    const sync=()=>{
      if(pending||!alive)return;pending=true;
      void window.novel.generationPreview(projectId).then(snapshot=>{
        if(!alive)return;
        const retained = current.previews.filter(p=>p.completed&&!snapshot.previews.some(n=>n.attemptId===p.attemptId));
        current={...snapshot,previews:[...retained,...snapshot.previews]};
        for(const e of queue.sort((a,b)=>a.sequence-b.sequence))apply(e);
        queue=[];setError(false);
        for(const p of current.previews)if(p.completed)settle(p);
        publish();
      }).catch(()=>{if(alive)setError(true);}).finally(()=>{pending=false;});
    };
    syncRef.current=sync;
    const off=window.novel.onGenerationDelta(event=>{
      if(!alive)return;
      if(pending){queue.push(event);return;}
      if(event.sequence>current.revision+1){queue.push(event);sync();return;}
      apply(event);publish();
    });
    sync();
    return ()=>{alive=false;off();queue=[];};
  },[projectId]);
  return {previews:state.previews.filter(p=>p.projectId===projectId),error,retry:()=>syncRef.current()};
}
function label(path:string){
  if(path==="message")return "创作搭档";
  const chapter=/^chapters\.(\d+)\./.exec(path);
  if(chapter)return `正文预览 ${Number(chapter[1])+1}`;
  if(path.startsWith("artifacts."))return "阶段成果预览";
  return "正文预览";
}
function Preview({value}:{value:GenerationPreview}){
  const scroll=useRef<HTMLDivElement>(null),stick=useRef(true);
  const [following,setFollowing]=useState(true);
  useLayoutEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[value.sequence]);
  return <section className="generation-preview" aria-label="生成预览" data-task-id={value.taskId} data-attempt-id={value.attemptId}>
    <div className="generation-preview-heading"><strong>{value.completed?"正在读取已保存结果":"生成中预览，尚未保存"}</strong><span role="status">{value.phase}</span></div>
    <div className="generation-preview-body" ref={scroll} tabIndex={0} aria-live="off" aria-label="预览内容" onScroll={()=>{
      const node=scroll.current;if(!node)return;stick.current=node.scrollHeight-node.scrollTop-node.clientHeight<32;setFollowing(stick.current);
    }}>
      {value.parts.map(part=><div key={part.path} className="generation-preview-part" data-path={part.path}>
        <small>{label(part.path)}</small><div>{part.text}</div>
      </div>)}
    </div>
    {!following&&<button className="subtle" onClick={()=>{stick.current=true;setFollowing(true);if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;}}>回到最新</button>}
  </section>;
}
export function GenerationPreviews({projectId,refresh}:{projectId:string;refresh:()=>Promise<void>}){
  const {previews,error,retry}=usePreviews(projectId,refresh);
  return <>{previews.map(value=><Preview key={value.attemptId} value={value}/>)}{error&&<p className="hint warn">预览同步暂未完成。<button onClick={retry}>重新同步预览</button></p>}</>;
}
