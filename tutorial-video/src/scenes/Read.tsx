import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const Read: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="像读者一样，检查自己的稿子" eyebrow="05 / 看稿 → 阅读与审阅" tip="阅读 → 选段批注 → 改稿 → 作者复核" steps={["定位或搜索正文","选段批注，交给助手","读完标记已审"]}>
   <Sequence name="reader" from={0 * fps} durationInFrames={10 * fps} premountFor={fps}><ScreenPanel asset="reader" crop={[200,150,1225,588]}  /></Sequence>
<Sequence name="审阅与批注" from={10 * fps} durationInFrames={15 * fps} premountFor={fps}><ScreenPanel asset="annotation" crop={[846,178,570,274]}  label="审阅与批注"/></Sequence>
   </SceneFrame><Audio src={staticFile('audio/Read.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "写完后，进入左侧的看稿。",
    "startMs": 700,
    "endMs": 3179,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "可以按章节定位，也可以搜索正文。",
    "startMs": 3339,
    "endMs": 6537,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "字号、行距和阅读宽度都能调整。",
    "startMs": 6697,
    "endMs": 9852,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "切换审阅，选中文字，就能添加批注，",
    "startMs": 10012,
    "endMs": 13758,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "或把这段文字交给助手处理。",
    "startMs": 13918,
    "endMs": 16544,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "本章看完后，标记本章已审。",
    "startMs": 16704,
    "endMs": 19449,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "已审正文再次修改，会提醒待复核。",
    "startMs": 19609,
    "endMs": 23086,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
