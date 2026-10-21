// 行的修改、删除和撤销 —— 每个操作在一个事务里完成并写 edits
import { db } from './db';
import { mergeTextAt, splitLineAt } from './lines_ops';
import { diffFragment } from './lexicon';
import type { EditKind, LabelSource, LineRecord } from './types';

export class ManualEditError extends Error {}

async function logEdit(
  videoId: number,
  kind: EditKind,
  before: LineRecord[],
  after: number[],
  changed?: { oldText: string; newText: string },
): Promise<void> {
  await db.edits.add({
    videoId,
    lineId: before[0]?.id ?? null,
    kind,
    before,
    after,
    oldText: changed?.oldText,
    newText: changed?.newText,
    at: Date.now(),
  });
}

async function getLine(lineId: number): Promise<LineRecord> {
  const line = await db.lines.get(lineId);
  if (!line) throw new Error(`行不存在：${lineId}`);
  return line;
}

/** 改字：写入 text，edited 置真，记 edits */
export async function editText(lineId: number, text: string): Promise<void> {
  const line = await getLine(lineId);
  const trimmed = text.replace(/\s*\n\s*/g, ' ').trim();
  // 记下「被替换的片段」：同一处替换出现 2 次就自动进易错词表（用户改一次是偶然，改两次是规律）
  const frag = diffFragment(line.text, trimmed);
  await db.transaction('rw', db.lines, db.edits, async () => {
    await db.lines.update(lineId, { text: trimmed, edited: true, updatedAt: Date.now() });
    await logEdit(line.videoId, 'text', [line], [lineId],
      frag ? { oldText: frag.old, newText: frag.new } : undefined);
  });
}

/** 打标签 / 清标签（labelId 为 null 表示清除） */
export async function setLabel(
  lineIds: number[],
  labelId: number | null,
  source: LabelSource = 'user',
): Promise<void> {
  const before: LineRecord[] = [];
  for (const id of lineIds) before.push(await getLine(id));
  const videoId = before[0].videoId;
  await db.transaction('rw', db.lines, db.edits, async () => {
    for (const id of lineIds) {
      await db.lines.update(id, {
        labelId,
        labelSource: labelId === null ? null : source,
        updatedAt: Date.now(),
      });
    }
    await logEdit(videoId, 'label', before, lineIds);
  });
}

/** 在 text 的第 k 个字符处拆行 */
export async function splitLine(lineId: number, offset: number): Promise<void> {
  const line = await getLine(lineId);
  await db.transaction('rw', db.lines, db.edits, async () => {
    await splitLineAt(db, line, offset);
  });
}

/** 合并到上一行 */
export async function mergeWithPrev(lineId: number): Promise<void> {
  const line = await getLine(lineId);
  const prev = await db.lines
    .where('[videoId+idx]')
    .equals([line.videoId, line.idx - 1])
    .first();
  if (!prev) throw new Error('已经是第一行');
  await db.transaction('rw', db.lines, db.edits, async () => {
    await mergeTextAt(db, prev, line);
  });
}

/** 删除行 */
export async function deleteLine(lineId: number): Promise<void> {
  const line = await getLine(lineId);
  await db.transaction('rw', db.lines, db.edits, async () => {
    await db.lines.delete(lineId);
    await reindex(db, line.videoId, line.idx);
    await logEdit(line.videoId, 'delete', [line], []);
  });
}

/** 恢复：text 回到 textAi（没有就回到 textAsr），edited 置假 */
export async function revertLine(lineId: number, to: 'ai' | 'asr' = 'ai'): Promise<void> {
  const line = await getLine(lineId);
  const target = to === 'ai' && line.textAi ? line.textAi : line.textAsr;
  await db.transaction('rw', db.lines, db.edits, async () => {
    await db.lines.update(lineId, { text: target, edited: false, updatedAt: Date.now() });
    await logEdit(line.videoId, 'revert', [line], [lineId]);
  });
}

/** 撤销这条视频最近一次修改 */
export async function undo(videoId: number): Promise<void> {
  await db.transaction('rw', db.lines, db.edits, async () => {
    const history = await db.edits.where('videoId').equals(videoId).sortBy('at');
    const edit = history[history.length - 1];
    if (!edit) return;
    // 删掉 after 里的行，按原 id 放回 before 里的行，重排 idx
    for (const id of edit.after) {
      const exists = await db.lines.get(id);
      if (exists && !edit.before.some((b) => b.id === id)) await db.lines.delete(id);
    }
    const idxs = edit.before.map((b) => b.idx).sort((a, b) => a - b);
    for (const snap of edit.before) {
      const rec: LineRecord = { ...snap, updatedAt: Date.now() };
      if (rec.id != null) await db.lines.put(rec);
      else await db.lines.add(rec);
    }
    await reindex(db, videoId, idxs[0] ?? 0);
    await db.edits.delete(edit.id!);
  });
}

/** 删除一行/插入行后重排 idx（fromIdx 起受影响） */
export async function reindex(
  tx: typeof db,
  videoId: number,
  fromIdx: number,
): Promise<void> {
  const rest = await db.lines
    .where('videoId')
    .equals(videoId)
    .and((l) => l.idx >= fromIdx)
    .sortBy('idx');
  let i = fromIdx;
  for (const l of rest) {
    if (l.idx !== i) await db.lines.update(l.id!, { idx: i });
    i++;
  }
}

/** 切换成行方式：有人工修改时抛错 */
export async function resegmentCheck(videoId: number): Promise<void> {
  const lines = await db.lines.where('videoId').equals(videoId).toArray();
  const hasManual = lines.some((l) => l.edited || l.labelSource === 'user');
  if (hasManual) throw new ManualEditError('已有手动修改，不能重新分行');
}
