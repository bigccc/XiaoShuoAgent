import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
const exec=promisify(execFile);
const root=path.resolve(import.meta.dirname,'..');
const shots=[['Intro',60],['Connect',260],['NewWork',60],['NewWork',260],['NewWork',480],['Prepare',60],['Prepare',330],['Prepare',600],['Write',60],['Write',300],['Write',650],['Read',90],['Read',500],['Revise',120],['Revise',600],['Export',100],['Export',650],['Outro',90]];
await fs.mkdir(path.join(root,'generated/qa'),{recursive:true});
let cursor=0;
async function worker(){
 while(cursor<shots.length){
  const index=cursor++; const [scene,frame]=shots[index];
  await exec('/Users/dave/.nvm/versions/node/v22.22.1/bin/node',['node_modules/@remotion/cli/remotion-cli.js','still','src/index.ts',scene,`generated/qa/${String(index).padStart(2,'0')}-${scene}.png`,`--frame=${frame}`],{cwd:root,maxBuffer:1024*1024});
  console.log(`${index+1}/${shots.length}: ${scene} frame ${frame}`);
 }
}
await Promise.all([worker(),worker(),worker()]);
const scenes=JSON.parse(await fs.readFile(path.join(root,'src/storyboard.json'),'utf8'));
for(const scene of scenes){
 const duration=Number((await exec('/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',path.join(root,`public/audio/${scene.id}.mp3`)])).stdout.trim());
 if(Math.abs(duration-scene.duration)>.1) throw Error(`Audio mismatch in ${scene.id}`);
 for(const c of scene.captions) if(c.startMs<0||c.endMs>scene.duration*1000||c.endMs<=c.startMs) throw Error(`Caption mismatch in ${scene.id}`);
}
console.log('All scene audio durations and caption intervals match the timeline.');
