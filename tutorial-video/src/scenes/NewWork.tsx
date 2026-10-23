import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const NewWork: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="一句灵感，就可以开始" eyebrow="02 / 书架 → 新建作品" tip="示例：少女 + 会说话的猫 + 寻找家人" steps={["书架里新建作品","选择想法或灵感","说清主角与冲突"]}>
   <Sequence name="new-work" from={0 * fps} durationInFrames={6 * fps} premountFor={fps}><ScreenPanel asset="new-work" crop={[192,95,1225,588]}  /></Sequence>
<Sequence name="start" from={6 * fps} durationInFrames={6 * fps} premountFor={fps}><ScreenPanel asset="start" crop={[192,100,1225,588]}  /></Sequence>
<Sequence name="输入你的故事想法" from={12 * fps} durationInFrames={8 * fps} premountFor={fps}><ScreenPanel asset="idea" crop={[200,683,490,235]}  label="输入你的故事想法"/></Sequence>
   </SceneFrame><Audio src={staticFile('audio/NewWork.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "回到书架，点击新建作品。",
    "startMs": 700,
    "endMs": 3292,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "书名可以先留空，再慢慢确定。",
    "startMs": 3452,
    "endMs": 6382,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "有想法，就点我有一个想法。",
    "startMs": 6542,
    "endMs": 9183,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "还没想好，可以让助手推荐灵感。",
    "startMs": 9343,
    "endMs": 12512,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "说清主角、冲突，以及想要的风格，",
    "startMs": 12672,
    "endMs": 16043,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "然后点击发送。",
    "startMs": 16203,
    "endMs": 17707,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
