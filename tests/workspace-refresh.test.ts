import {expect,it} from "vitest";
import {LatestRefresh} from "../src/renderer/workspace-refresh";
it("an obsolete refresh waits for the newest applied snapshot before acknowledging completion",async()=>{
  const gate=new LatestRefresh<number>();let resolveOld!:(value:number)=>void,resolveNew!:(value:number)=>void;
  const applied:number[]=[];let acknowledged=false;
  const old=gate.run(()=>new Promise<number>(r=>{resolveOld=r;}),n=>applied.push(n)).then(()=>{acknowledged=true;});
  const latest=gate.run(()=>new Promise<number>(r=>{resolveNew=r;}),n=>applied.push(n));
  resolveOld(1);await Promise.resolve();await Promise.resolve();
  expect(applied).toEqual([]);expect(acknowledged).toBe(false);
  resolveNew(2);await latest;await old;
  expect(applied).toEqual([2]);expect(acknowledged).toBe(true);
});
