import {createHash} from "node:crypto";
import type {BuiltContext} from "./context";
import type {Store} from "./store";

export const CHECK_CACHE_PROTOCOL = "verified-evidence-v1";
export function issueIdentity(issue: {type?:string;category?:string;reason?:string;impact?:string;chapterId?:string;evidence:unknown[]}) {
  const evidence = issue.evidence.map(e => JSON.stringify(e)).sort();
  return JSON.stringify([issue.type ?? issue.category, issue.impact, issue.chapterId, evidence]);
}
/** Derived, local results. Callers must re-parse evidence and check live sources. */
export class CheckCache {
  constructor(private store:Store) {}
  key(input:{projectId:string;context:BuiltContext;profile:unknown;protocol:string;request:unknown}) {
    return createHash("sha256").update(JSON.stringify([CHECK_CACHE_PROTOCOL,input])).digest("hex");
  }
  get(projectId:string,key:string) {return this.store.getCheckCache(projectId,key);}
  put(projectId:string,key:string,raw:string) {if(Buffer.byteLength(raw,"utf8")<=512*1024)this.store.putCheckCache(projectId,key,raw);}
  remove(projectId:string,key:string) {this.store.deleteCheckCache(projectId,key);}
}
