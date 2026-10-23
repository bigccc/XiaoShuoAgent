import type { GenerationDelta, GenerationPreviewSnapshot } from "../shared/generation-preview";
/** Sequence includes all projects; ignored projects still advance the cursor. */
export function applyGenerationDelta(state: GenerationPreviewSnapshot, event: GenerationDelta, projectId: string): GenerationPreviewSnapshot {
  if (event.sequence <= state.revision) return state;
  const next = {...state,revision:event.sequence};
  if (event.projectId !== projectId) return next;
  const key = (p: {kind:string;taskId:string}) => p.kind === event.kind && p.taskId === event.taskId;
  const sameAttempt = (p: {kind:string;taskId:string;attemptId:string}) => key(p) && p.attemptId === event.attemptId;
  const old = state.previews.find(sameAttempt);
  if (event.op === "reset") {
    const {op:_,...meta}=event;
    return {...next,previews:[...state.previews.filter(p=>!key(p) || p.completed),{...meta,completed:false}]};
  }
  if (!old || old.attemptId !== event.attemptId) return next;
  if(event.op === "end") return {...next,previews:event.outcome === "cancelled" ? state.previews.filter(p=>!sameAttempt(p)) : state.previews.map(p=>sameAttempt(p)?{...p,completed:true,sequence:event.sequence}:p)};
  const part=old.parts.find(p=>p.path===event.path);
  return {...next,previews:state.previews.map(p=>sameAttempt(p)?{...p,sequence:event.sequence,parts:part?p.parts.map(n=>n.path===event.path?{...n,text:n.text+event.text}:n):[...p.parts,{path:event.path,text:event.text}]}:p)};
}
