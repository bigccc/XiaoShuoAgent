import React from 'react';
import {AbsoluteFill, CanvasImage, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

export const palette = {paper:'#f5f2e9',ink:'#203e37',green:'#227260',soft:'#e3ebe0',muted:'#708178',gold:'#d5aa5b'};
const font='"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
export const Background: React.FC<{children: React.ReactNode}> = ({children}) => <AbsoluteFill style={{background:palette.paper,color:palette.ink,fontFamily:font}}>
  <div style={{position:'absolute',right:-230,top:-370,width:970,height:970,border:'1px solid #d6dfd1',borderRadius:'50%'}} />
  <div style={{position:'absolute',right:-150,top:-290,width:810,height:810,border:'1px solid #d6dfd1',borderRadius:'50%'}} />
  <div style={{position:'absolute',left:80,top:48,fontSize:25,letterSpacing:3,color:palette.green}}>✦ 小说工坊</div>
  <div style={{position:'absolute',right:84,top:52,fontSize:23,color:palette.muted}}>使用教程 · 当前界面</div>
  {children}
</AbsoluteFill>;

export const SceneFrame:React.FC<{title:string;eyebrow:string;tip:string;steps:string[];children:React.ReactNode}> = ({title,eyebrow,tip,steps,children})=>{
  const frame=useCurrentFrame();const {fps,durationInFrames}=useVideoConfig();
  const active=Math.min(steps.length-1,Math.floor(frame/durationInFrames*steps.length));
  return <Background>
    <div style={{position:'absolute',left:80,top:108,fontSize:27,color:palette.green,letterSpacing:2}}>{eyebrow}</div>
    <div style={{position:'absolute',left:80,top:155,fontSize:66,fontWeight:600,letterSpacing:-1,opacity:interpolate(frame,[0,.4*fps],[0,1],{extrapolateRight:'clamp'}),translate:interpolate(frame,[0,.6*fps],['0px 14px','0px 0px'],{extrapolateRight:'clamp',easing:Easing.bezier(.16,1,.3,1)})}}>{title}</div>
    <div style={{position:'absolute',left:80,top:310,width:450}}>
      {steps.map((step,index)=><div key={step} style={{display:'flex',alignItems:'flex-start',gap:19,marginBottom:42,opacity:index<=active?1:.38}}>
        <div style={{flexShrink:0,width:44,height:44,marginTop:8,background:index===active?palette.green:palette.soft,color:index===active?'white':palette.green,borderRadius:'50%',fontSize:24,display:'flex',alignItems:'center',justifyContent:'center'}}>{index+1}</div>
        <div style={{fontSize:43,fontWeight:index===active?600:400,lineHeight:1.4}}>{step}</div>
      </div>)}
    </div>
    {children}
    <div style={{position:'absolute',left:610,top:859,width:1230,fontSize:28,color:palette.green,lineHeight:1.5}}>{tip}</div>
    <div style={{position:'absolute',left:80,bottom:18,fontSize:19,color:palette.muted}}>示例作品《雨巷里的猫》 · 内容仅供操作演示</div>
    <div style={{position:'absolute',left:0,bottom:0,height:5,width:interpolate(frame,[0,durationInFrames],[0,1920]),background:palette.green}} />
  </Background>;
};

type ScreenProps={asset:string;crop:readonly[number,number,number,number];highlight?:readonly[number,number,number,number];label?:string};
export const ScreenPanel:React.FC<ScreenProps>=({asset,crop,highlight,label})=>{
  const frame=useCurrentFrame();const {fps}=useVideoConfig();
  const factor=1230/crop[2];
  return <div style={{position:'absolute',left:610,top:250,width:1230,height:590,borderRadius:20,overflow:'hidden',boxShadow:'0 24px 65px #233d3725',border:'1px solid #cdd8c9',background:'#faf8f2',opacity:interpolate(frame,[0,.25*fps],[0,1],{extrapolateRight:'clamp'})}}>
    <CanvasImage src={staticFile(`screens/${asset}.png`)} premountFor={fps} style={{position:'absolute',width:1440*factor,height:920*factor,left:-crop[0]*factor,top:-crop[1]*factor}} />
    {highlight && <div style={{position:'absolute',left:(highlight[0]-crop[0])*factor,top:(highlight[1]-crop[1])*factor,width:highlight[2]*factor,height:highlight[3]*factor,border:'4px solid #227260',borderRadius:10,boxShadow:'0 0 0 6px #22726018',opacity:interpolate(frame,[0,.6*fps,1.2*fps],[0,.7,1],{extrapolateRight:'clamp'})}}>
      <svg width="45" height="55" viewBox="0 0 45 55" style={{position:'absolute',right:-24,bottom:-35,filter:'drop-shadow(0 3px 4px #0004)'}}><path d="M4 3 L5 42 L17 32 L27 52 L36 47 L25 28 L41 26 Z" fill="#227260" stroke="white" strokeWidth="3" /></svg>
    </div>}
    {label && <div style={{position:'absolute',top:16,right:16,padding:'8px 14px',fontSize:22,background:palette.ink,color:'white',borderRadius:8}}>{label}</div>}
  </div>;
};

export const BookMark:React.FC<{size?:number}>=({size=260})=><svg width={size} height={size} viewBox="0 0 240 240">
  <circle cx="120" cy="120" r="110" fill={palette.soft} />
  <path d="M120 62 C97 49 63 45 40 51 L40 176 C64 169 97 170 120 184 C143 170 176 169 200 176 L200 51 C177 45 143 49 120 62 Z" fill="#fffdf6" stroke={palette.green} strokeWidth="5" />
  <path d="M120 63 V179 M57 76 Q85 72 105 84 M57 97 Q85 93 105 105 M57 118 Q85 114 105 126 M137 84 Q158 73 184 77 M137 105 Q158 94 184 98 M137 126 Q158 115 184 119" stroke={palette.green} strokeWidth="4" fill="none" strokeLinecap="round" />
  <path d="M173 23 L179 37 L194 43 L179 49 L173 64 L167 49 L152 43 L167 37 Z" fill={palette.gold}/>
</svg>;
