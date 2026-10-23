/** A skipped response must not acknowledge a refresh before its successor applies. */
export class LatestRefresh<T> {
  private generation=0;
  private latest:Promise<void>=Promise.resolve();
  run(request:()=>Promise<T>,apply:(value:T)=>void):Promise<void>{
    const generation=++this.generation;
    const pending=(async()=>{
      const result=await request();
      if(generation===this.generation)apply(result);
      else await this.latest;
    })();
    this.latest=pending;
    return pending;
  }
}
