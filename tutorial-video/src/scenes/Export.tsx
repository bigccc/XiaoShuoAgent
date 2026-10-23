import React from 'react';
import {Sequence, staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {BasicCaptions} from '../basic-captions';
import {SceneFrame, ScreenPanel} from '../SceneFrame';

export const Export: React.FC = () => {
const {fps}=useVideoConfig();

return (<><SceneFrame title="正文交付，作品完整备份" eyebrow="07 / 作品顶部 → 导出" tip="TXT / Word 用于交稿；完整作品包用于备份迁移" steps={["确认导出草稿范围","TXT / Word 用于交稿","作品包保留完整资料"]}>
   <Sequence name="导出正文" from={0 * fps} durationInFrames={12 * fps} premountFor={fps}><ScreenPanel asset="export" crop={[368,335,865,415]} highlight={[471,475,163,40]} label="导出正文"/></Sequence>
<Sequence name="完整作品备份" from={12 * fps} durationInFrames={16 * fps} premountFor={fps}><ScreenPanel asset="export" crop={[368,572,865,415]} highlight={[377,683,115,43]} label="完整作品备份"/></Sequence>
   </SceneFrame><Audio src={staticFile('audio/Export.mp3')} premountFor={fps} /><BasicCaptions name="中文字幕" premountFor={fps} width={1760} combineTokensWithinMilliseconds={0} style={{position:'absolute',left:80,top:925}} captions={[
  {
    "text": "需要交稿时，点击作品顶部的导出。",
    "startMs": 700,
    "endMs": 4109,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "先确认是否包含未确认草稿，",
    "startMs": 4269,
    "endMs": 7085,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "再选择文本，或 Word 文档。",
    "startMs": 7245,
    "endMs": 9846,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "需要保留对话、设定和版本历史，",
    "startMs": 10006,
    "endMs": 13067,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "请选择备份完整作品，保存作品包。",
    "startMs": 13227,
    "endMs": 16833,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "导入作品包会创建独立副本。",
    "startMs": 16993,
    "endMs": 19660,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "换电脑后，需要重新配置 AI 连接。",
    "startMs": 19820,
    "endMs": 23132,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  },
  {
    "text": "重要修改和迁移前，记得另存备份。",
    "startMs": 23292,
    "endMs": 26671,
    "timestampMs": null,
    "confidence": null,
    "pageBreakAfter": true
  }
]} /></>);
};
