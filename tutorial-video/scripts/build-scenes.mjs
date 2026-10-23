import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const scenes=JSON.parse(await fs.readFile(path.join(root,'src/storyboard.json'),'utf8'));
const basic=(await fs.readFile('/tmp/xiaoshuo-basic-captions.md','utf8')).match(/```tsx[^\n]*\n([\s\S]*?)```/)[1];
await fs.writeFile(path.join(root,'src/basic-captions.tsx'),basic);
await fs.mkdir(path.join(root,'src/scenes'),{recursive:true});
const configs={
  Connect:{steps:['选择服务商','粘贴自己的密钥','保存并测试连接'],shots:[{asset:'connection',start:0,end:23,crop:[386,150,1010,485],highlight:[394,536,84,42]}]},
  NewWork:{steps:['书架里新建作品','选择想法或灵感','说清主角与冲突'],shots:[{asset:'new-work',start:0,end:6,crop:[192,95,1225,588]},{asset:'start',start:6,end:12,crop:[192,100,1225,588]},{asset:'idea',start:12,end:20,crop:[200,683,490,235],label:'输入你的故事想法'}]},
  Prepare:{steps:['读故事概要','确认方向，做准备','确认设定与大纲'],shots:[{asset:'direction',start:0,end:8,crop:[714,98,700,336]},{asset:'direction',start:8,end:13,crop:[202,585,490,235],label:'确认方向，做准备'},{asset:'preparation',start:13,end:27,crop:[736,568,650,312],label:'查看大纲成果'}]},
  Write:{steps:['先写一章，找到感觉','设置章节数与字数','看进度，暂停或继续'],shots:[{asset:'writing',start:0,end:6,crop:[737,312,650,312]},{asset:'continuous',start:6,end:17,crop:[207,493,480,230],label:'连续写作设置'},{asset:'progress',start:17,end:28,crop:[210,167,1010,485],label:'保存进度 ≠ 检查进度'}]},
  Read:{steps:['定位或搜索正文','选段批注，交给助手','读完标记已审'],shots:[{asset:'reader',start:0,end:10,crop:[200,150,1225,588]},{asset:'annotation',start:10,end:25,crop:[846,178,570,274],label:'审阅与批注'}]},
  Revise:{steps:['单章、多章或全书','说明修改与保留内容','比较待审稿，再采纳'],shots:[{asset:'revision',start:0,end:16,crop:[197,604,570,274],label:'明确修改范围'},{asset:'materials',start:16,end:24,crop:[393,162,1010,485],label:'维护人物与世界资料'}]},
  Export:{steps:['确认导出草稿范围','TXT / Word 用于交稿','作品包保留完整资料'],shots:[{asset:'export',start:0,end:12,crop:[368,335,865,415],highlight:[471,475,163,40],label:'导出正文'},{asset:'export',start:12,end:28,crop:[368,572,865,415],highlight:[377,683,115,43],label:'完整作品备份'}]}
};
for(const scene of scenes){
 const captions=`<BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={${JSON.stringify(scene.captions,null,2)}} />`;
 const media=`<Audio src={staticFile('audio/${scene.id}.mp3')} premountFor={fps} />`;
 let markup;
 if(scene.kind==='intro'||scene.kind==='outro'){
  markup=`<Background>
   <div style={{position:'absolute',left:110,top:180,fontSize:31,color:palette.green,letterSpacing:3}}>${scene.eyebrow}</div>
   <div style={{position:'absolute',left:110,top:265,fontSize:104,fontWeight:600,lineHeight:1.35,width:1130,opacity:interpolate(frame,[0,.5*fps],[0,1],{extrapolateRight:'clamp'})}}>${scene.title.replace('，','，<br/>')}</div>
   <div style={{position:'absolute',right:150,top:285}}><BookMark size={370}/></div>
   <div style={{position:'absolute',left:110,top:630,display:'flex',gap:28}}>${scene.steps.map((s,i)=>`<div style={{padding:'22px 32px',borderRadius:14,background:${i===0?'palette.green':'palette.soft'},color:${i===0?"'white'":'palette.green'},fontSize:38}}>${s}</div>`).join('')}</div>
   <div style={{position:'absolute',left:110,top:780,fontSize:30,color:palette.muted}}>本机保存作品 · 你来决定方向与采纳</div>
   ${media}${captions}
  </Background>`;
 }else{
  const config=configs[scene.id];
  markup=`<><SceneFrame title=${JSON.stringify(scene.title)} eyebrow=${JSON.stringify(scene.eyebrow)} tip=${JSON.stringify(scene.tip)} steps={${JSON.stringify(config.steps)}}>
   ${config.shots.map(shot=>`<Sequence name=${JSON.stringify(shot.label??shot.asset)} from={${shot.start} * fps} durationInFrames={${shot.end-shot.start} * fps} premountFor={fps}><ScreenPanel asset=${JSON.stringify(shot.asset)} crop={${JSON.stringify(shot.crop)}} ${shot.highlight?`highlight={${JSON.stringify(shot.highlight)}}`:''} ${shot.label?`label=${JSON.stringify(shot.label)}`:''}/></Sequence>`).join('\n')}
   </SceneFrame>${media}${captions}</>`;
 }
 const imports=`import React from 'react';\nimport {${scene.kind==='intro'||scene.kind==='outro'?'interpolate, useCurrentFrame,':'Sequence,'} staticFile,useVideoConfig} from 'remotion';\nimport {Audio} from '@remotion/media';\nimport {BasicCaptions} from '../basic-captions';\nimport {${scene.kind==='intro'||scene.kind==='outro'?'Background, BookMark, palette':'SceneFrame, ScreenPanel'}} from '../SceneFrame';\n`;
 await fs.writeFile(path.join(root,`src/scenes/${scene.id}.tsx`),`${imports}\nexport const ${scene.id}: React.FC = () => {\nconst {fps}=useVideoConfig();\n${scene.kind==='intro'||scene.kind==='outro'?'const frame=useCurrentFrame();':''}\nreturn (${markup});\n};\n`);
}
const imports=scenes.map(s=>`import {${s.id}} from './scenes/${s.id}';`).join('\n');
await fs.writeFile(path.join(root,'src/Root.tsx'),`import React from 'react';\nimport {Composition, Folder, Series, useVideoConfig} from 'remotion';\n${imports}\n\nexport const Tutorial:React.FC=()=>{const {fps}=useVideoConfig(); return <Series>\n${scenes.map(s=>`<Series.Sequence name=${JSON.stringify(s.title)} durationInFrames={${s.duration} * fps} premountFor={fps}><${s.id}/></Series.Sequence>`).join('\n')}\n</Series>;};\n\nexport const RemotionRoot: React.FC = () => <>\n<Composition id="XiaoShuoTutorial" component={Tutorial} width={1920} height={1080} fps={30} durationInFrames={${scenes.reduce((n,s)=>n+s.frames,0)}} />\n<Folder name="Scenes">\n${scenes.map(s=>`<Composition id="${s.id}" component={${s.id}} width={1920} height={1080} fps={30} durationInFrames={${s.frames}} />`).join('\n')}\n</Folder>\n</>;\n`);
console.log(`Built ${scenes.length} editable scenes.`);
