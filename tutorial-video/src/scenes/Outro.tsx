import React from 'react';
import {interpolate, useCurrentFrame, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {Background, BookMark, palette} from '../SceneFrame';

export const Outro: React.FC = () => {
const {fps}=useVideoConfig();
const frame=useCurrentFrame();
return (<Background>
   <div style={{position:'absolute',left:110,top:180,fontSize:31,color:palette.green,letterSpacing:3}}>小说工坊 · 把创作留在你手里</div>
   <div style={{position:'absolute',left:110,top:265,fontSize:104,fontWeight:600,lineHeight:1.35,width:1130,opacity:interpolate(frame,[0,.5*fps],[0,1],{extrapolateRight:'clamp'})}}>从今天的第一章开始</div>
   <div style={{position:'absolute',right:150,top:285}}><BookMark size={370}/></div>
   <div style={{position:'absolute',left:110,top:630,display:'flex',gap:28}}><div style={{padding:'22px 32px',borderRadius:14,background:palette.green,color:'white',fontSize:38}}>创作</div><div style={{padding:'22px 32px',borderRadius:14,background:palette.soft,color:palette.green,fontSize:38}}>看稿</div><div style={{padding:'22px 32px',borderRadius:14,background:palette.soft,color:palette.green,fontSize:38}}>故事资料</div></div>
   <div style={{position:'absolute',left:110,top:780,fontSize:30,color:palette.muted}}>本机保存作品 · 你来决定方向与采纳</div>
   <Audio src={staticFile('audio/Outro.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "记住这条路线：",
    "startMs": 700,
    "endMs": 2077,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "创作里推进故事，看稿里审阅，",
    "startMs": 2237,
    "endMs": 5127,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "故事资料里维护设定。",
    "startMs": 5287,
    "endMs": 7134,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "把想法写下来，开始你的第一章吧。",
    "startMs": 7294,
    "endMs": 10421,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} />
  </Background>);
};
