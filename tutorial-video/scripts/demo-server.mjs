import {createServer} from 'node:http';
let turns = 0;
const opening = '雨下了一整晚。\n\n阿宁抱着纸箱走进巷子，路灯把她的影子拉得很长。箱子里只有一件旧外套，一张写着地址的纸条，还有母亲留下的铜铃。\n\n“你迟到了。”\n\n声音从墙头传来。阿宁抬头，看见一只黑猫，正用金色的眼睛打量她。\n\n“你……会说话？”\n\n黑猫没有回答，只用爪子指了指她怀里的铜铃。“如果你想找到她，天亮之前，跟我走。”\n\n阿宁握紧铜铃。雨水顺着指尖滴落，她第一次觉得，那条没有尽头的巷子，也许通向一个答案。';
const server = createServer(async (req,res) => {
  let raw=''; for await(const c of req) raw+=c;
  const body=JSON.parse(raw);
  let response;
  if(body.messages?.some(m=>m.content?.includes('STAGE_SYNC_NORMALIZE'))){
    const input=JSON.parse(body.messages.at(-1).content);
    response={stage:input.stage,blocks:input.text.trim()?[input.stage==='outline'?{kind:'note',noteType:'outline',title:'故事大纲',startLine:1,endLine:input.lineCount}:{kind:'field',field:input.stage==='overview'?'background':'style',startLine:1,endLine:input.lineCount}]:[],removeNoteIds:[],removeFields:[]};
  }else if(body.messages?.some(m=>m.content?.includes('连续写作·'))){
    const sys=body.messages.find(m=>m.role==='system').content;
    response=sys.includes('规划')?{plan:'从雨巷相遇到进入旧书店，推进寻找家人的主线。',majorChange:false,reason:''}:sys.includes('生成')||sys.includes('修订')?{title:'雨巷之后',content:opening,majorChange:false,reason:''}:{issues:[],majorChange:false,reason:''};
    await new Promise(resolve=>setTimeout(resolve,10000));
  }else{
    turns++;
    response=turns===1?{message:'推荐以“雨巷里的猫”为故事起点：少女阿宁在雨夜遇见一只会说话的黑猫，循着母亲留下的铜铃寻找失散的家人。先确定人物的愿望和核心冲突，再准备人物与大纲。',artifacts:[{stage:'overview',blocks:[{kind:'field',field:'background',text:'少女阿宁带着母亲留下的铜铃，来到陌生城市。会说话的黑猫知道母亲的去向，却只愿透露一条线索。她必须在天亮之前作出选择：继续独自寻找，或跟随黑猫走进隐藏的世界。'}]}]}:turns===2?{message:'人物设定与故事大纲已准备。请阅读右侧成果，你可以提出修改，再确认进入正文。',artifacts:[{stage:'settings',blocks:[{kind:'note',noteType:'character',title:'阿宁',text:'十七岁的少女，敏感但勇敢。希望找到失散的母亲。习惯遇事自己承担，却需要学会信任伙伴。'},{kind:'note',noteType:'character',title:'黑猫',text:'能说话的引路者，知道铜铃的秘密。外冷内热，守着不能轻易说出口的承诺。'}]},{stage:'outline',blocks:[{kind:'note',noteType:'outline',title:'故事大纲',text:'第一章：雨巷相遇，黑猫说出阿宁的名字。\n第二章：旧书店里发现母亲留下的线索。\n第三章：铜铃唤醒城市另一面的入口。\n中段：伙伴关系经受考验，揭开母亲失踪的原因。\n结局：阿宁选择承担责任，带着新的理解与家人重逢。'}]}]}:{message:'第一章已保存为草稿。可以在右侧修改文字，或进入看稿阅读与审阅。',chapters:[{title:'雨巷里的猫',content:opening,stage:'opening'}]};
  }
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(response)},finish_reason:'stop'}],usage:{total_tokens:300,prompt_tokens:100,completion_tokens:200}}));
});
server.listen(43127,'127.0.0.1',()=>console.log('Tutorial demonstration fixture ready on 43127; no external model calls.'));
