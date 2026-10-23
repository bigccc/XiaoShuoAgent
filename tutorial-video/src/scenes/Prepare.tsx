import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const Prepare: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="你定方向，助手做准备" eyebrow="03 / 定故事 → 做准备" tip="先看成果，再确认；也可以先写一段看看" steps={["读故事概要","确认方向，做准备","确认设定与大纲"]}>
   <Sequence name="direction" from={0 * fps} durationInFrames={8 * fps} premountFor={fps}><ScreenPanel asset="direction" crop={[714,98,700,336]}  /></Sequence>
<Sequence name="确认方向，做准备" from={8 * fps} durationInFrames={5 * fps} premountFor={fps}><ScreenPanel asset="direction" crop={[202,585,490,235]}  label="确认方向，做准备"/></Sequence>
<Sequence name="查看大纲成果" from={13 * fps} durationInFrames={14 * fps} premountFor={fps}><ScreenPanel asset="preparation" crop={[736,568,650,312]}  label="查看大纲成果"/></Sequence>
   </SceneFrame><Audio src={staticFile('audio/Prepare.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "创作按照定故事、做准备、开始写推进。",
    "startMs": 700,
    "endMs": 4657,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "先阅读右侧的故事概要。",
    "startMs": 4817,
    "endMs": 6797,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "方向合适，点确认方向，做准备。",
    "startMs": 6957,
    "endMs": 10389,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "助手会集中准备人物设定和大纲。",
    "startMs": 10549,
    "endMs": 13464,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "检查人物动机、主要转折和结局方向。",
    "startMs": 13624,
    "endMs": 17184,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "需要调整，就直接在对话里说明。",
    "startMs": 17344,
    "endMs": 20556,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "看好成果后，点击按推荐继续。",
    "startMs": 20716,
    "endMs": 23763,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
