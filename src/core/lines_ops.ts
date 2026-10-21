// lines.ts 的事务内实现：拆行 / 合并的写库细节
import type { Table } from 'dexie';
import { mergeTexts, splitTimeAt, splitTokensAt } from './segment';
import type { EditRecord, LineRecord } from './types';

interface DBLike {
  lines: Table<LineRecord, number>;
  edits: Table<EditRecord, number>;
}

async function logEdit(
  db: DBLike,
  videoId: number,
  kind: EditRecord['kind'],
  before: LineRecord[],
  after: number[],
  changed?: { oldText: string; newText: string },
): Promise<void> {
  await db.edits.add({
    videoId, lineId: before[0]?.id ?? null, kind, before, after,
    oldText: changed?.oldText, newText: changed?.newText,
    at: Date.now(),
  });
}

/** 在光标处拆行（事务内调用） */
export async function splitLineAt(db: DBLike, line: LineRecord, offset: number): Promise<void> {
  const k = Math.max(0, Math.min(offset, line.text.length));
  const leftText = line.text.slice(0, k).trim();
  const rightText = line.text.slice(k).trim();
  if (!leftText || !rightText) throw new Error('拆行位置不能在行首或行尾');

  const { t, precise } = splitTimeAt(line, k);
  const [leftTokens, rightTokens] = splitTokensAt(line, k, precise);

  const { id: _oldId, ...base } = line;
  const left: LineRecord = {
    ...base,
    text: leftText,
    textAsr: leftText,
    textAi: leftText,
    edited: true,
    startMs: line.startMs,
    endMs: Math.max(line.startMs + 1, t),
    tokens: leftTokens,
    updatedAt: Date.now(),
  };
  const right: LineRecord = {
    ...base,
    text: rightText,
    textAsr: rightText,
    textAi: rightText,
    edited: true,
    startMs: t,
    endMs: line.endMs,
    tokens: rightTokens,
    updatedAt: Date.now(),
  };

  await db.lines.delete(line.id!);
  // 保持原 id 的行先放回，新行分配新 id
  const leftId = await db.lines.add(left);
  const rightId = await db.lines.add(right);

  // 重排 idx：原行之后的全部 +1
  const rest = await db.lines
    .where('videoId')
    .equals(line.videoId)
    .and((l) => l.idx > line.idx)
    .sortBy('idx');
  for (const l of rest.reverse()) {
    await db.lines.update(l.id!, { idx: l.idx + 1 });
  }
  await db.lines.update(leftId as number, { idx: line.idx });
  await db.lines.update(rightId as number, { idx: line.idx + 1 });

  await logEdit(db, line.videoId, 'split', [line], [leftId as number, rightId as number]);
}

/** 合并到上一行（事务内调用） */
export async function mergeTextAt(db: DBLike, prev: LineRecord, cur: LineRecord): Promise<void> {
  const merged: LineRecord = {
    ...prev,
    text: mergeTexts(prev.text, cur.text),
    textAsr: mergeTexts(prev.textAsr, cur.textAsr),
    textAi: '',
    edited: true,
    startMs: prev.startMs,
    endMs: cur.endMs,
    tokens: prev.tokens && cur.tokens ? [...prev.tokens, ...cur.tokens] : null,
    updatedAt: Date.now(),
  };
  await db.lines.update(prev.id!, merged);
  await db.lines.delete(cur.id!);
  // 后续行前移
  const rest = await db.lines
    .where('videoId')
    .equals(cur.videoId)
    .and((l) => l.idx > cur.idx)
    .sortBy('idx');
  for (const l of rest) await db.lines.update(l.id!, { idx: l.idx - 1 });

  await logEdit(db, cur.videoId, 'merge', [prev, cur], [prev.id!]);
}
