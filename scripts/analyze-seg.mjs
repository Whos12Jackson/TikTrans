// 分析真实 ASR 分段 → 为什么被切成一堆短行
import { readFileSync } from 'node:fs';
import { segmentsToLines, alignCharsToTokens } from '../src/core/segment.ts';

const dump = JSON.parse(readFileSync(new URL('../.asr-dump.json', import.meta.url), 'utf-8'));
const segs = dump[0].result;
console.log(`段数：${segs.length}`);
segs.forEach((s, i) => {
  const map = alignCharsToTokens(s.text, s.tokens ?? []);
  const ok = map.some((x) => x >= 0);
  console.log(`\n[段${i}] ${(s.startMs / 1000).toFixed(1)}s→${(s.endMs / 1000).toFixed(1)}s  ${s.text.length}字  词元${s.tokens?.length ?? 0}个  对齐${ok ? '成功' : '失败'}`);
  console.log('  文本：' + s.text.slice(0, 80) + '…');
  console.log('  前5个词元：' + JSON.stringify((s.tokens ?? []).slice(0, 5)));
});

const lines = segmentsToLines(segs, { lineMode: 'sentence' });
console.log(`\n=== 整句模式结果：${lines.length} 行 ===`);
lines.slice(0, 12).forEach((l) => {
  console.log(`[${(l.startMs / 1000).toFixed(1)}s→${(l.endMs / 1000).toFixed(1)}s] ${l.text}`);
});
