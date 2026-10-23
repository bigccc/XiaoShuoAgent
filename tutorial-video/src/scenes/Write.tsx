import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const Write: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="先写一章，再接着写" eyebrow="04 / 创作 → 开始写" tip="“写完前五章”补齐目标；“接着写五章”新增章节" steps={["先写一章，找到感觉","设置章节数与字数","看进度，暂停或继续"]}>
   <Sequence name="writing" from={0 * fps} durationInFrames={6 * fps} premountFor={fps}><ScreenPanel asset="writing" crop={[737,312,650,312]}  /></Sequence>
<Sequence name="连续写作设置" from={6 * fps} durationInFrames={11 * fps} premountFor={fps}><ScreenPanel asset="continuous" crop={[207,493,480,230]}  label="连续写作设置"/></Sequence>
<Sequence name="保存进度 ≠ 检查进度" from={17 * fps} durationInFrames={11 * fps} premountFor={fps}><ScreenPanel asset="progress" crop={[210,167,1010,485]}  label="保存进度 ≠ 检查进度"/></Sequence>
   </SceneFrame><Audio src={staticFile('audio/Write.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "进入开始写，右侧就是当前章节正文。",
    "startMs": 700,
    "endMs": 4295,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "正文会自动保存，也可以直接手改。",
    "startMs": 4455,
    "endMs": 7788,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "展开写下一章、连续写作，",
    "startMs": 7948,
    "endMs": 10492,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "设置一次几章、每章大约多少字。",
    "startMs": 10652,
    "endMs": 13698,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "也可以直接说，写完前五章。",
    "startMs": 13858,
    "endMs": 16627,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "接着写五章，则是在末章后新增五章。",
    "startMs": 16787,
    "endMs": 20266,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "待处理里可查看进度、暂停或继续。",
    "startMs": 20426,
    "endMs": 23835,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "已保存和已检查，要分别看。",
    "startMs": 23995,
    "endMs": 26753,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
