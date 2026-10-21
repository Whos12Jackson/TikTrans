// 易错词表（术语表）：把识别错的字词按用户给的对照表替换掉
//
// 背景：SenseVoice 离线识别只支持 greedy 解码（官方明确报错），没有 beam search 可调；
// 剩下的同音字错误（美誉→美玉、瓦丽→瓦砾、切懦→怯懦）只能靠词表后处理纠正。
// 词表由用户维护：每行一条「错字=正字」，例如：
//   美誉=美玉
//   瓦丽=瓦砾
//   切懦=怯懦
// 规则：错字与正字必须等长（避免把整句结构改坏）；命中时按整词优先、其次按子串替换。

export interface LexiconPair {
  wrong: string;
  right: string;
}

/** 解析词表文本：忽略空行与 # 注释；错字/正字必须等长且非空 */
export function parseLexicon(text: string): LexiconPair[] {
  const out: LexiconPair[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const wrong = line.slice(0, idx).trim();
    const right = line.slice(idx + 1).trim();
    if (!wrong || !right) continue;
    if (wrong.length !== right.length) continue; // 等长才替换，防止误伤
    if (wrong === right) continue;
    out.push({ wrong, right });
  }
  // 长的错词优先替换（避免"徒"先被替换掉，导致"徒劳"匹配不上）
  out.sort((a, b) => b.wrong.length - a.wrong.length);
  return out;
}

/** 对一段文本应用词表 */
export function applyLexicon(text: string, pairs: LexiconPair[]): string {
  if (!text || pairs.length === 0) return text;
  let out = text;
  for (const p of pairs) {
    if (out.includes(p.wrong)) out = out.split(p.wrong).join(p.right);
  }
  return out;
}

/** 词表统计（设置页展示） */
export function lexiconStats(text: string): { count: number; sample: string } {
  const pairs = parseLexicon(text);
  return {
    count: pairs.length,
    sample: pairs.slice(0, 3).map((p) => `${p.wrong}→${p.right}`).join('、'),
  };
}

// ---------- 从改字记录里自动学习 ----------

/**
 * 取两段文本的差异片段：用户把「美誉」改成「美玉」→ 旧片段"美誉"、新片段"美玉"
 * （按公共前后缀裁剪，剩下中间那段就是被替换的部分）
 */
export function diffFragment(oldText: string, newText: string): { old: string; new: string } | null {
  if (!oldText || !newText || oldText === newText) return null;
  const minLen = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < minLen && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const oldFrag = oldText.slice(start, endOld);
  const newFrag = newText.slice(start, endNew);
  if (!oldFrag || !newFrag) return null;
  return { old: oldFrag, new: newFrag };
}

/**
 * 从改字记录里挖「错词→正词」候选：
 * 同一处替换出现 ≥2 次才认定为规律（改一次可能是偶然），片段长度 2~8 字且等长。
 */
export function mineLexicon(
  edits: { kind: string; oldText?: string; newText?: string }[],
  minCount = 2,
): LexiconPair[] {
  const counter = new Map<string, { pair: LexiconPair; count: number }>();
  for (const e of edits) {
    if (e.kind !== 'text' || !e.oldText || !e.newText) continue;
    const wrong = e.oldText.trim();
    const right = e.newText.trim();
    if (wrong.length < 2 || wrong.length > 8) continue;
    if (wrong.length !== right.length) continue;
    if (wrong === right) continue;
    const key = `${wrong}=${right}`;
    const cur = counter.get(key);
    if (cur) cur.count++;
    else counter.set(key, { pair: { wrong, right }, count: 1 });
  }
  return [...counter.values()]
    .filter((x) => x.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .map((x) => x.pair);
}

/** 把学到的词条渲染成词表文本（追加到用户词表后面） */
export function lexiconToText(pairs: LexiconPair[]): string {
  return pairs.map((p) => `${p.wrong}=${p.right}`).join('\n');
}
