import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const scenes=JSON.parse(await fs.readFile(path.join(import.meta.dirname,'storyboard.json'),'utf8'));
await fs.mkdir(path.join(root,'public/audio'),{recursive:true});
await fs.mkdir(path.join(root,'generated'),{recursive:true});
const probe=(file)=>Number(execFileSync('/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{encoding:'utf8'}).trim());
let totalFrames=0;const globalCaptions=[];
for(const scene of scenes){
  const chunks=[]; const captions=[]; let cursor=.7;
  const silence=path.join(root,'generated/silence.wav');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','0.16',silence]);
  const lead=path.join(root,'generated/lead.wav');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','0.7',lead]);
  chunks.push(lead);
  for(let i=0;i<scene.lines.length;i++){
    const aiff=path.join(root,`generated/${scene.id}-${i}.aiff`);
    const wav=path.join(root,`generated/${scene.id}-${i}.wav`);
    execFileSync('/usr/bin/say',['-v','Tingting','-r','210','-o',aiff,scene.lines[i]]);
    execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',aiff,'-ar','44100','-ac','1',wav]);
    const duration=probe(wav);
    const caption={text:scene.lines[i],startMs:Math.round(cursor*1000),endMs:Math.round((cursor+duration)*1000),timestampMs:null,confidence:null,pageBreakAfter:true};
    captions.push(caption);globalCaptions.push({...caption,startMs:caption.startMs+totalFrames/30*1000,endMs:caption.endMs+totalFrames/30*1000});
    chunks.push(wav,silence);cursor+=duration+.16;
  }
  scene.duration=Math.max(scene.duration,Math.ceil(cursor+1));
  const concat=path.join(root,`generated/${scene.id}-concat.txt`);
  await fs.writeFile(concat,chunks.map(x=>`file '${x}'`).join('\n'));
  execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-f','concat','-safe','0','-i',concat,'-af',`apad=whole_dur=${scene.duration},alimiter=level_in=1:level_out=1:limit=0.95`,'-t',String(scene.duration),'-ar','44100','-c:a','libmp3lame','-b:a','192k',path.join(root,`public/audio/${scene.id}.mp3`)]);
  scene.captions=captions;scene.startFrame=totalFrames;scene.frames=scene.duration*30;totalFrames+=scene.frames;
  console.log(`${scene.id}: ${scene.duration}s`);
}
await fs.writeFile(path.join(root,'src/storyboard.json'),JSON.stringify(scenes,null,2));
await fs.writeFile(path.join(root,'public/captions.json'),JSON.stringify(globalCaptions,null,2));
const time=(ms)=>{const n=Math.round(ms);return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')},${String(n%1000).padStart(3,'0')}`};
await fs.writeFile(path.join(root,'public/小说工坊使用教程.srt'),globalCaptions.map((c,i)=>`${i+1}\n${time(c.startMs)} --> ${time(c.endMs)}\n${c.text}\n`).join('\n'));
console.log(`Total: ${totalFrames/30}s / ${totalFrames} frames`);
