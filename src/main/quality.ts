const checkSchema =
  '只返回 JSON：{"issues":[{"type":"character|timeline|location|world|knowledge|foreshadowing","reason":"明确矛盾双方及为何不能同时成立","evidence":[{"quote":"支持矛盾一方的逐字原文","source":{"kind":"project|note|chapter","id":"来源ID","revision":1}}]}],"majorChange":false,"reason":"可选暂停原因"}。source须复制原文方括号内的kind、id和@后的实际revision，例中的1不是默认版本。quote必须是连续逐字原文，不改标点或省略拼接跨行句子。JSON之外不得追加任何文字。';

/** Inspect presentation-only errors without changing quoted evidence or values.
 * The result must still pass the same semantic/source validation as normal JSON. */
export function checkJsonContent(raw: string): string {
  const content = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let text = "", quoted = false, escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (!quoted && char === "," && /^\s*[}\]]/.test(content.slice(i + 1))) continue;
    text += char;
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return text;
}

// Resolve only whitespace differences to one unique source span; stored quotes
// remain exact originals, never rewritten facts or ambiguous source matches.
export function canonicalQuote(
  text: string,
  quote: string,
): string | undefined {
  if (text.includes(quote)) return quote;
  const wanted = quote.replace(/\s/g, "");
  if (!wanted) return;
  let compact = "";
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    compact += text[i];
    offsets.push(i);
  }
  const start = compact.indexOf(wanted);
  if (start < 0 || compact.indexOf(wanted, start + 1) >= 0) return;
  return text.slice(offsets[start], offsets[start + wanted.length - 1] + 1);
}

export const consistencyInstruction =
  checkSchema +
  "逐项核对人物、时间、地点、规则、知情、伏笔，特别追踪同一物体的位置、持有者和动作前后状态，例如已收回信封的信纸不能同时仍在桌上。" +
  "issues仅列有明确原文证据、无法同时成立的事实冲突，按重要性最多列3项。每项同时引用矛盾双方，只保留能证明该矛盾的最短完整引文；一句已含双方时可只引一句。" +
  "通过意见、正常时间推进、允许的配角或外部观察、尚未描写的后续过渡、缺少信息的猜测均不放入issues。不要求六类各填一项；无确定冲突返回issues=[]。" +
  "区分角色猜测、说谎、回忆与叙述事实；考虑人物移动、取放物品、时间流逝等已写出的解释。真正重大且明确改变剧情或设定时才majorChange=true，不把一般疑点设为重大变化。";

export const reviewInstruction =
  checkSchema +
  "复核初检疑点：请独立阅读下面原文，不依赖此前结论。逐一检验矛盾双方是否同一对象、同一时间、同一事实口径，是否已有动作或情节合理解释。" +
  "删除通过意见、缺乏信息的推测和正常衔接，剔除每项中无关的引文，例如‘他拆开’不能证明年龄矛盾。保留确实互斥的双方事实及各自直接证据，不为凑六类补项。" +
  "只有原文明写的取出、交还、移动等动作才能解释物品状态转移；不得凭空补写动作，也不得把叙述者明确陈述的状态矛盾解释成‘普通物理现象’来消除。每项务必选中导致互斥状态的两处直接原文，而非先前无矛盾的取放动作。" +
  "无论初检是否为空，都独立核对原文中的同一人物年龄、物品位置与持有状态等事实矛盾。叙述者明确陈述的生日和年龄视为事实；原文未写说谎或误认时不能凭空假设来消除矛盾。只输出复核后确定成立的issues，最多3项；没有确定冲突返回issues=[]。未解决的重大变更才保留majorChange=true。";
