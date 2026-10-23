import React from 'react';
import {Composition, Folder, Series, useVideoConfig} from 'remotion';
import {Intro} from './scenes/Intro';
import {Connect} from './scenes/Connect';
import {NewWork} from './scenes/NewWork';
import {Prepare} from './scenes/Prepare';
import {Write} from './scenes/Write';
import {Read} from './scenes/Read';
import {Revise} from './scenes/Revise';
import {Export} from './scenes/Export';
import {Outro} from './scenes/Outro';

export const Tutorial:React.FC=()=>{const {fps}=useVideoConfig(); return <Series>
<Series.Sequence name="让一个想法，长成一本书" durationInFrames={13 * fps} premountFor={fps}><Intro/></Series.Sequence>
<Series.Sequence name="先连接你的创作搭档" durationInFrames={23 * fps} premountFor={fps}><Connect/></Series.Sequence>
<Series.Sequence name="一句灵感，就可以开始" durationInFrames={20 * fps} premountFor={fps}><NewWork/></Series.Sequence>
<Series.Sequence name="你定方向，助手做准备" durationInFrames={27 * fps} premountFor={fps}><Prepare/></Series.Sequence>
<Series.Sequence name="先写一章，再接着写" durationInFrames={28 * fps} premountFor={fps}><Write/></Series.Sequence>
<Series.Sequence name="像读者一样，检查自己的稿子" durationInFrames={25 * fps} premountFor={fps}><Read/></Series.Sequence>
<Series.Sequence name="把修改范围说清楚" durationInFrames={24 * fps} premountFor={fps}><Revise/></Series.Sequence>
<Series.Sequence name="正文交付，作品完整备份" durationInFrames={28 * fps} premountFor={fps}><Export/></Series.Sequence>
<Series.Sequence name="从今天的第一章开始" durationInFrames={12 * fps} premountFor={fps}><Outro/></Series.Sequence>
</Series>;};

export const RemotionRoot: React.FC = () => <>
<Composition id="XiaoShuoTutorial" component={Tutorial} width={1920} height={1080} fps={30} durationInFrames={6000} />
<Folder name="Scenes">
<Composition id="Intro" component={Intro} width={1920} height={1080} fps={30} durationInFrames={390} />
<Composition id="Connect" component={Connect} width={1920} height={1080} fps={30} durationInFrames={690} />
<Composition id="NewWork" component={NewWork} width={1920} height={1080} fps={30} durationInFrames={600} />
<Composition id="Prepare" component={Prepare} width={1920} height={1080} fps={30} durationInFrames={810} />
<Composition id="Write" component={Write} width={1920} height={1080} fps={30} durationInFrames={840} />
<Composition id="Read" component={Read} width={1920} height={1080} fps={30} durationInFrames={750} />
<Composition id="Revise" component={Revise} width={1920} height={1080} fps={30} durationInFrames={720} />
<Composition id="Export" component={Export} width={1920} height={1080} fps={30} durationInFrames={840} />
<Composition id="Outro" component={Outro} width={1920} height={1080} fps={30} durationInFrames={360} />
</Folder>
</>;
