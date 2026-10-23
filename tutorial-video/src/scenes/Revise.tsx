import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const Revise: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="把修改范围说清楚" eyebrow="06 / 创作 → 选择改稿范围" tip="示例：增强第一章悬念，保留人物动机和结尾" steps={["单章、多章或全书","说明修改与保留内容","比较待审稿，再采纳"]}>
   <Sequence name="明确修改范围" from={0 * fps} durationInFrames={16 * fps} premountFor={fps}><ScreenPanel asset="revision" crop={[197,604,570,274]}  label="明确修改范围"/></Sequence>
<Sequence name="维护人物与世界资料" from={16 * fps} durationInFrames={8 * fps} premountFor={fps}><ScreenPanel asset="materials" crop={[393,162,1010,485]}  label="维护人物与世界资料"/></Sequence>
   </SceneFrame><Audio src={staticFile('audio/Revise.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "回到创作，展开选择改稿范围。",
    "startMs": 700,
    "endMs": 3884,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "可以改当前章、指定多章，或全书。",
    "startMs": 4044,
    "endMs": 7614,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "说明哪些地方需要调整，",
    "startMs": 7774,
    "endMs": 10031,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "也说明哪些人物和情节必须保留。",
    "startMs": 10191,
    "endMs": 13169,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "多章修改先生成待审稿，",
    "startMs": 13329,
    "endMs": 15752,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "比较差异后，由你决定是否采纳。",
    "startMs": 15912,
    "endMs": 18958,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "人物、世界和规划，在故事资料中维护。",
    "startMs": 19118,
    "endMs": 22793,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
