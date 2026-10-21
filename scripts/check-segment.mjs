// 用真实形态的数据检查成行算法（Node 直跑，与浏览器同源代码）
import { segmentsToLines } from '../src/core/segment.ts';

const mk = (startMs, endMs, text) => ({ startMs, endMs, text, tokens: [] });

console.log('=== 场景1：一整段 40 秒的文本（VAD 段很大）===');
const s1 = [mk(0, 40000, '读书最爽的时候是什么？我觉得是你总能发现你自己的感受，在很早之前就被世上某个人已经说清楚了。我第一次感受到这样的冲击，是在高中读到这段话的时候，我生怕自己并非美誉。故而不敢加以刻苦琢磨，')];
console.log(segmentsToLines(s1, { lineMode: 'sentence' }).map((l) => l.text));

console.log('\n=== 场景2：多个短 VAD 段（每段几秒，段尾有句号）===');
const s2 = [
  mk(0, 6000, '读书最爽的时候是什么？'),
  mk(6000, 12000, '我觉得是你总能发现你自己的感受，在很早之前就被世上某个人已经说清楚了。'),
  mk(12000, 18000, '我第一次感受到这样的冲击，是在高中读到这段话的时候，'),
  mk(18000, 22000, '我生怕自己并非美誉。'),
];
console.log(segmentsToLines(s2, { lineMode: 'sentence' }).map((l) => l.text));

console.log('\n=== 场景3：段尾短句（假句号）===');
const s3 = [mk(0, 800, '所以。'), mk(1200, 2500, '别怕。')];
console.log(segmentsToLines(s3, { lineMode: 'sentence' }).map((l) => l.text));
