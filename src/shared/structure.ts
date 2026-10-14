import {z} from "zod";import {DomainError} from "./validation";import type {RecordMeta} from "./types";
export type StructureView="scenes"|"threads"|"characters"|"pov"|"foreshadowing";
export type StructureProblem="pov"|"thread"|"voice"|"foreshadowing"|"repetition"|"conflict";
export interface StructureLink {planId:string;cardId:string;chapterId:string;revision:number;ordinal:number}
export interface StructureThread {id:string;revision:number;title:string;kind:"main"|"subplot";description:string;archived:boolean;links:StructureLink[]}
export interface StructureToken {kind:"scene"|"foreshadowing";id:string;cardId?:string;threadId?:string;code:"missing-pov"|"source-changed"|"link-changed"|"payoff";proof:string}
export interface StructureWorkspace extends RecordMeta {projectId:string;threads:StructureThread[];dismissed:StructureToken[];history:Omit<StructureWorkspace,"history">[]}
export interface StructureQuery {projectId:string;view:StructureView;offset?:number;limit?:number;fromOrdinal?:number;toOrdinal?:number;query?:string;entityNoteId?:string;threadId?:string;showIgnored?:boolean}
export interface StructureWarning {token:StructureToken;text:string;ignored:boolean}
export interface StructureRow {id:string;kind:"scene"|"chapter"|"foreshadowing"|"missing";title:string;chapterId?:string;ordinal:number;chapterRevision?:number;planId?:string;planRevision?:number;cardId?:string;cardRevision?:number;pov?:string;summary:string;status:string;anchorAvailable?:boolean;warnings:StructureWarning[]}
export interface StructurePage {rows:StructureRow[];total:number;offset:number;nextOffset:number|null}
export type StructureCommand=
 |{type:"structure.threadSave";projectId:string;id?:string;revision?:number;title:string;kind:"main"|"subplot";description:string;scenes:{planId:string;cardId:string}[]}
 |{type:"structure.threadArchive";projectId:string;id:string;revision:number;archived:boolean}
 |{type:"structure.dismiss";projectId:string;token:StructureToken;ignored:boolean}
 |{type:"structure.restore";projectId:string;revision:number;historyRevision:number}
 |{type:"structure.revise";projectId:string;target:{kind:"scene"|"chapter";id:string;revision:number;cardId?:string};problem:StructureProblem;text:string;tokenBudget:number;profileId?:string};
const id=z.string().min(1).max(200),rev=z.number().int().min(1),link=z.object({planId:id,cardId:id,chapterId:id,revision:rev,ordinal:rev}).strict();
const thread=z.object({id,revision:rev,title:z.string().trim().min(1).max(120),kind:z.enum(["main","subplot"]),description:z.string().max(1000),archived:z.boolean(),links:z.array(link).max(1000)}).strict();
const token=z.object({kind:z.enum(["scene","foreshadowing"]),id,cardId:id.optional(),threadId:id.optional(),code:z.enum(["missing-pov","source-changed","link-changed","payoff"]),proof:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const frame=z.object({id,revision:rev,createdAt:z.string().datetime(),updatedAt:z.string().datetime(),projectId:id,threads:z.array(thread).max(50),dismissed:z.array(token).max(1000)}).strict();
function check(schema:z.ZodType,value:unknown){if(!schema.safeParse(value).success)throw new DomainError("VALIDATION","结构导航数据或范围不正确");}
export function validateStructureWorkspace(value:unknown):asserts value is StructureWorkspace {check(frame.extend({history:z.array(frame).max(10)}).strict(),value);const w=value as StructureWorkspace;for(const f of [w,...w.history])if(f.projectId!==w.projectId||f.id!==w.id||f.threads.reduce((n,t)=>n+t.links.length,0)>1000||new Set(f.threads.map(t=>t.id)).size!==f.threads.length||f.threads.some(t=>new Set(t.links.map(l=>l.cardId)).size!==t.links.length)||new Set(f.dismissed.map(t=>JSON.stringify(t))).size!==f.dismissed.length)throw new DomainError("VALIDATION","结构关联或历史重复、越界");if(w.history.some((h,i)=>h.revision>=w.revision||i>0&&h.revision<=w.history[i-1].revision))throw new DomainError("VALIDATION","结构历史版本不正确");}
export function validateStructureQuery(q:unknown):asserts q is StructureQuery {check(z.object({projectId:id,view:z.enum(["scenes","threads","characters","pov","foreshadowing"]),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(40).optional(),fromOrdinal:rev.optional(),toOrdinal:rev.optional(),query:z.string().max(120).optional(),entityNoteId:id.optional(),threadId:id.optional(),showIgnored:z.boolean().optional()}).strict(),q);const v=q as StructureQuery;if((v.fromOrdinal??1)>(v.toOrdinal??Number.MAX_SAFE_INTEGER))throw new DomainError("VALIDATION","章节范围不正确");}
export function validateStructureCommand(c:unknown):asserts c is StructureCommand {check(z.discriminatedUnion("type",[
 z.object({type:z.literal("structure.threadSave"),projectId:id,id:id.optional(),revision:rev.optional(),title:z.string().trim().min(1).max(120),kind:z.enum(["main","subplot"]),description:z.string().max(1000),scenes:z.array(z.object({planId:id,cardId:id}).strict()).max(1000)}).strict(),
 z.object({type:z.literal("structure.threadArchive"),projectId:id,id,revision:rev,archived:z.boolean()}).strict(),z.object({type:z.literal("structure.dismiss"),projectId:id,token,ignored:z.boolean()}).strict(),z.object({type:z.literal("structure.restore"),projectId:id,revision:rev,historyRevision:rev}).strict(),
 z.object({type:z.literal("structure.revise"),projectId:id,target:z.object({kind:z.enum(["scene","chapter"]),id,revision:rev,cardId:id.optional()}).strict(),problem:z.enum(["pov","thread","voice","foreshadowing","repetition","conflict"]),text:z.string().max(4000),tokenBudget:z.number().int().min(1).max(1000000),profileId:id.optional()}).strict()]),c);}
