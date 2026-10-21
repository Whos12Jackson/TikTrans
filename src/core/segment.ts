// 成行规则，以及拆行/合并时的时间计算
import type { AsrSegment, LineMode, LineRecord, TokenTuple } from './types';

export interface SegmentOptions {
  lineMode: LineMode;
  maxLineChars: number;   // 每行最多字数（不算标点），默认 60
  pauseBreakMs: number;   // 换行停顿（短句模式用），默认 1200
  maxLineSec: number;     // 每行最长时长（秒），默认 20（够放一句完整长句）
  minLineChars: number;   // 短于这个字数的行会并入相邻行，默认 8
  sentenceGapMs: number;  // 段尾句号要当成"真句子边界"所需的停顿，默认 1200
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  lineMode: 'sentence',
  maxLineChars: 60,
  pauseBreakMs: 1200,
  maxLineSec: 20,
  minLineChars: 8,
  sentenceGapMs: 1200,
};

const PUNCT_SPLIT = /[，、；：,;:。！？!?…]/;     // 在这些标点后切开（标点留在前半句尾）
const SENT_END = /[。！？!?…]/;                 // 句末标点
export const isPunct = (ch: string): boolean => /[\p{P}\p{S}]/u.test(ch);

/** 短句：一段文本 + 起止时间 + 词元 */
interface Clause {
  text: string;
  startMs: number;
  endMs: number;
  tokens: TokenTuple[];
  /** 来自第几个语音段（识别是分段做的，段边界上的句号常常是"假句号"） */
  segIndex: number;
  /** 是否是这个语音段的最后一句（段尾的句号多半是模型补的） */
  isChunkEnd: boolean;
}

/**
 * 把词元时间对齐到文本字符：tokens[i][0] 去掉 ▁ 前缀后依次拼接与 text 对齐，
 * 对不上时退回按字数插值。返回每个字符对应的词元下标（对齐失败为 -1）。
 */
export function alignCharsToTokens(text: string, tokens: TokenTuple[]): number[] {
  const map = new Array<number>(text.length).fill(-1);
  if (tokens.length === 0) return map;
  let pos = 0;
  for (let ti = 0; ti < tokens.length; ti++) {
    const raw = tokens[ti][0].replace(/^▁/, '');
    for (const ch of raw) {
      // 跳过文本里多余的空白
      while (pos < text.length && text[pos] === ' ') pos++;
      if (pos >= text.length) return map;
      if (text[pos] === ch) {
        map[pos] = ti;
        pos++;
      } else {
        // 对不上：放弃精确对齐，整体退回插值
        return new Array<number>(text.length).fill(-1);
      }
    }
  }
  return map;
}

/** 按字数插值字符时间（对齐失败时的兜底） */
function charTimeInterp(clause: { text: string; startMs: number; endMs: number }, charIdx: number): number {
  const n = clause.text.length || 1;
  return clause.startMs + ((clause.endMs - clause.startMs) * charIdx) / n;
}

function clauseFromSegment(seg: AsrSegment, segIndex: number): Clause[] {
  const text = seg.text;
  const clauses: Clause[] = [];
  const charMap = alignCharsToTokens(text, seg.tokens);

  // 按标点切短句（标点留在短句尾部）
  let start = 0;
  const boundaries: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (PUNCT_SPLIT.test(text[i])) boundaries.push(i + 1);
  }
  if (boundaries.length === 0 || boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }

  for (const end of boundaries) {
    const chunk = text.slice(start, end);
    if (!chunk.trim()) {
      start = end;
      continue;
    }
    // 时间：用短句首尾字符对应的词元
    const firstChar = start;
    const lastChar = end - 1;
    const t0 = charMap[firstChar] >= 0
      ? seg.tokens[charMap[firstChar]][1]
      : charTimeInterp({ ...seg, text }, firstChar);
    const t1 = charMap[lastChar] >= 0
      ? seg.tokens[charMap[lastChar]][2]
      : charTimeInterp({ ...seg, text }, end);
    const tokens: TokenTuple[] = seg.tokens.filter((_, ti) =>
      charMap.slice(start, end).includes(ti));
    clauses.push({
      text: chunk,
      startMs: t0,
      endMs: Math.max(t0 + 1, t1),
      tokens,
      segIndex,
      isChunkEnd: end === text.length,
    });
    start = end;
  }
  return clauses;
}

const countCharsNoPunct = (s: string): number =>
  [...s].filter((c) => !isPunct(c)).length;

/** 单个超长短句：在 30%~70% 范围里找词元间停顿最长的位置切开 */
function splitLongClause(clause: Clause, maxChars: number): Clause[] {
  if (countCharsNoPunct(clause.text) <= maxChars) return [clause];
  const chars = [...clause.text];
  const lo = Math.floor(chars.length * 0.3);
  const hi = Math.ceil(chars.length * 0.7);
  const charMap = alignCharsToTokens(clause.text, clause.tokens);

  let bestIdx = -1;
  let bestPause = -1;
  for (let i = lo; i <= hi; i++) {
    if (i <= 0 || i >= chars.length) continue;
    const prev = charMap[i - 1];
    const next = charMap[i];
    if (prev >= 0 && next >= 0 && next > prev) {
      const pause = clause.tokens[next][1] - clause.tokens[prev][2];
      if (pause > bestPause) {
        bestPause = pause;
        bestIdx = i;
      }
    }
  }
  // 没有词元时间就按字数对半切
  const cut = bestIdx > 0 ? bestIdx : Math.ceil(chars.length / 2);

  const leftText = chars.slice(0, cut).join('');
  const rightText = chars.slice(cut).join('');
  const t = charMap[cut - 1] >= 0
    ? clause.tokens[charMap[cut - 1]][2]
    : clause.startMs + ((clause.endMs - clause.startMs) * cut) / chars.length;

  const left: Clause = {
    text: leftText,
    startMs: clause.startMs,
    endMs: Math.max(clause.startMs + 1, t),
    tokens: clause.tokens.filter((_, ti) => charMap.slice(0, cut).includes(ti)),
    segIndex: clause.segIndex,
    isChunkEnd: false,
  };
  const right: Clause = {
    text: rightText,
    startMs: t,
    endMs: clause.endMs,
    tokens: clause.tokens.filter((_, ti) => charMap.slice(cut).includes(ti)),
    segIndex: clause.segIndex,
    isChunkEnd: clause.isChunkEnd,
  };
  return [...splitLongClause(left, maxChars), ...splitLongClause(right, maxChars)];
}

/**
 * 成行：识别结果 → 行（不含 videoId/idx，由 lines 层写库）
 *
 * 整句模式（一行一句）：
 *   - 以句末标点（。！？）收尾 → 断行
 *   - 语音段之间即使有换气停顿也不断行（否则一句话被切成两半，不通顺）
 *   - 超过 maxLineChars / maxLineSec 才强制断
 *   - 语音段边界上的"假句号"（模型给每段都补句号，如独立的「所以。」）会并入下一句
 */
export function segmentsToLines(
  segments: AsrSegment[],
  opts: Partial<SegmentOptions> = {},
): Omit<LineRecord, 'id' | 'videoId' | 'idx' | 'updatedAt'>[] {
  const o: SegmentOptions = { ...DEFAULT_SEGMENT_OPTIONS, ...opts };

  // 1) 每段切成小句（标点留在小句尾部），超长的先按停顿/标点拆开
  const clauses: Clause[] = [];
  segments.forEach((seg, si) => {
    for (const c of clauseFromSegment(seg, si)) {
      clauses.push(...splitLongClause(c, o.maxLineChars));
    }
  });
  if (clauses.length === 0) return [];

  const mkLine = (cs: Clause[], startMs: number, endMs: number, tokens: TokenTuple[]) => ({
    startMs,
    endMs,
    textAsr: cs.map((c) => c.text).join(''),
    textAi: '',
    text: cs.map((c) => c.text).join(''),
    edited: false,
    tokens: tokens.length ? tokens : null,
    labelId: null,
    labelSource: null,
  });

  const textOf = (cs: Clause[]): string => cs.map((c) => c.text).join('');
  const endsSentence = (t: string): boolean => SENT_END.test(t.trim().slice(-1));

  // 2) 短句模式：一小句一行
  if (o.lineMode === 'clause') {
    return clauses.map((c) => mkLine([c], c.startMs, c.endMs, c.tokens));
  }

  // 3) 整句模式：按标点成行
  const lines: ReturnType<typeof mkLine>[] = [];
  let cur: Clause[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const tokens = cur.flatMap((c) => c.tokens);
    lines.push(mkLine(cur, cur[0].startMs, cur[cur.length - 1].endMs, tokens));
    cur = [];
  };

  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    if (cur.length === 0) { cur = [c]; continue; }

    const last = cur[cur.length - 1];

    // 情况 A：已累积的内容以句末标点结尾 → 这里真正决定「断行」还是「并入」
    if (endsSentence(last.text)) {
      if (last.isChunkEnd) {
        // 段尾的句号：模型给每段都补句号，多半是段边界产物。
        // 只有说话人真的停顿够久（≥ sentenceGapMs）才当成真句子边界。
        const gap = c.startMs - last.endMs;
        if (gap < o.sentenceGapMs) {
          last.text = last.text.replace(/。$/, '，'); // 降级成逗号，和下一句连成一句
        } else {
          flush();
          cur = [c];
          continue;
        }
      } else {
        // 段内的句号：真句子边界 → 断行
        flush();
        cur = [c];
        continue;
      }
    }

    const merged = textOf(cur) + c.text;
    const mergedChars = countCharsNoPunct(merged);
    const mergedDur = c.endMs - cur[0].startMs;

    // 情况 B：太长/太久 → 断行
    if (mergedChars > o.maxLineChars || mergedDur > o.maxLineSec * 1000) {
      flush();
      cur = [c];
      continue;
    }
    cur.push(c);
  }
  flush();

  return lines;
}

// ---------- 拆行 / 合并的时间计算 ----------

/** 光标在 text 的第 k 个字符处拆行的时间点（毫秒） */
export function splitTimeAt(line: Pick<LineRecord, 'startMs' | 'endMs' | 'text' | 'textAsr' | 'tokens'>, k: number): {
  t: number;
  precise: boolean;
} {
  const canPrecise = !line.textAsr || line.text === line.textAsr;
  const tokens = line.tokens;
  if (canPrecise && tokens && tokens.length > 0) {
    // 按顺序数 text 里的非标点字符，对上词元；切分时间取光标前最后一个词元的结束时间
    let nonPunctSeen = 0;
    let lastTokenEnd = -1;
    // 词元字符总数
    const tokenChars = tokens.map((tk) => [...tk[0].replace(/^▁/, '')].length);
    const totalTokenChars = tokenChars.reduce((a, b) => a + b, 0);
    const totalTextChars = [...line.text].filter((c) => !isPunct(c)).length;
    if (totalTokenChars === totalTextChars) {
      for (let i = 0; i < k && i < line.text.length; i++) {
        if (!isPunct(line.text[i])) nonPunctSeen++;
      }
      let acc = 0;
      for (let ti = 0; ti < tokens.length; ti++) {
        acc += tokenChars[ti];
        if (acc >= nonPunctSeen) {
          lastTokenEnd = tokens[ti][2];
          break;
        }
      }
      if (lastTokenEnd >= 0) {
        return { t: Math.min(Math.max(lastTokenEnd, line.startMs), line.endMs), precise: true };
      }
    }
  }
  // 算不了精确值：按字数比例插值，取整到毫秒
  const t = Math.round(line.startMs + ((line.endMs - line.startMs) * k) / (line.text.length || 1));
  return { t, precise: false };
}

/** 按光标位置把 tokens 切成两半（对不上就两边都置空） */
export function splitTokensAt(
  line: Pick<LineRecord, 'text' | 'tokens'>,
  k: number,
  precise: boolean,
): [TokenTuple[] | null, TokenTuple[] | null] {
  if (!precise || !line.tokens || line.tokens.length === 0) return [null, null];
  let nonPunctSeen = 0;
  for (let i = 0; i < k && i < line.text.length; i++) {
    if (!isPunct(line.text[i])) nonPunctSeen++;
  }
  const tokenChars = line.tokens.map((tk) => [...tk[0].replace(/^▁/, '')].length);
  const total = tokenChars.reduce((a, b) => a + b, 0);
  const totalText = [...line.text].filter((c) => !isPunct(c)).length;
  if (total !== totalText) return [null, null];
  let acc = 0;
  let cutIdx = line.tokens.length;
  for (let ti = 0; ti < line.tokens.length; ti++) {
    acc += tokenChars[ti];
    if (acc >= nonPunctSeen) {
      cutIdx = ti + 1;
      break;
    }
  }
  return [line.tokens.slice(0, cutIdx), line.tokens.slice(cutIdx)];
}

/** 合并两行的文本（仅在英文/数字边界补空格） */
export function mergeTexts(prev: string, cur: string): string {
  const needSpace = /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(cur);
  return needSpace ? `${prev} ${cur}` : prev + cur;
}
