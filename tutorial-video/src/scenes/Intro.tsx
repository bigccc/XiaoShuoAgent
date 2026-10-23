import React from 'react';
import {interpolate, useCurrentFrame, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {Background, BookMark, palette} from '../SceneFrame';

export const Intro: React.FC = () => {
const {fps}=useVideoConfig();
const frame=useCurrentFrame();
return (<Background>
   <div style={{position:'absolute',left:110,top:180,fontSize:31,color:palette.green,letterSpacing:3}}>小说工坊 · 新手使用教程</div>
   <div style={{position:'absolute',left:110,top:265,fontSize:104,fontWeight:600,lineHeight:1.35,width:1130,opacity:interpolate(frame,[0,.5*fps],[0,1],{extrapolateRight:'clamp'})}}>让一个想法，<br/>长成一本书</div>
   <div style={{position:'absolute',right:150,top:285}}><BookMark size={370}/></div>
   <div style={{position:'absolute',left:110,top:630,display:'flex',gap:28}}><div style={{padding:'22px 32px',borderRadius:14,background:palette.green,color:'white',fontSize:38}}>连接 AI</div><div style={{padding:'22px 32px',borderRadius:14,background:palette.soft,color:palette.green,fontSize:38}}>新建故事</div><div style={{padding:'22px 32px',borderRadius:14,background:palette.soft,color:palette.green,fontSize:38}}>创作与审阅</div><div style={{padding:'22px 32px',borderRadius:14,background:palette.soft,color:palette.green,fontSize:38}}>导出备份</div></div>
   <div style={{position:'absolute',left:110,top:780,fontSize:30,color:palette.muted}}>本机保存作品 · 你来决定方向与采纳</div>
   <Audio src={staticFile('audio/Intro.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "欢迎使用小说工坊。",
    "startMs": 700,
    "endMs": 2607,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "接下来，用三分钟走一遍，",
    "startMs": 2767,
    "endMs": 5294,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "从故事想法到稿件导出的创作流程。",
    "startMs": 5454,
    "endMs": 8818,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} />
  </Background>);
};
