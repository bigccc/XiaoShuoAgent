import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const Connect: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="先连接你的创作搭档" eyebrow="01 / 设置 → AI 连接" tip="选择服务商 → 粘贴密钥 → 保存连接" steps={["选择服务商","粘贴自己的密钥","保存并测试连接"]}>
   <Sequence name="connection" from={0 * fps} durationInFrames={23 * fps} premountFor={fps}><ScreenPanel asset="connection" crop={[386,150,1010,485]} highlight={[394,536,84,42]} /></Sequence>
   </SceneFrame><Audio src={staticFile('audio/Connect.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "先打开设置，进入 AI 连接。",
    "startMs": 700,
    "endMs": 3283,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "点击添加 AI 连接，选择服务商。",
    "startMs": 3443,
    "endMs": 6540,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "使用预设时，只需粘贴自己的密钥，",
    "startMs": 6700,
    "endMs": 9827,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "再点击保存连接。",
    "startMs": 9987,
    "endMs": 11683,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "测试连接会产生少量实际用量。",
    "startMs": 11843,
    "endMs": 14709,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "其他服务可以在高级设置中填写。",
    "startMs": 14869,
    "endMs": 17790,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
