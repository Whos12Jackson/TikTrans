// 撤销测试：每一种修改操作执行「操作 → undo」，数据库状态和操作前完全一致
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { deleteLine, editText, mergeWithPrev, revertLine, setLabel, splitLine, undo } from '../src/core/lines';
import type { LineRecord } from '../src/core/types';

const mk = (id: number, idx: number, text: string, startMs: number, endMs: number): LineRecord => ({
  id, videoId: 1, idx, startMs, endMs, textAsr: text, textAi: '', text,
  edited: false, tokens: null, labelId: null, labelSource: null, updatedAt: 0,
});

const snapshot = async (): Promise<Partial<LineRecord>[]> =>
  (await db.lines.where('videoId').equals(1).sortBy('idx')).map((l) => {
    const { updatedAt, ...rest } = l;
    return rest;
  });

beforeEach(async () => {
  await db.lines.clear();
  await db.edits.clear();
  await db.lines.bulkAdd([
    mk(1, 0, '第一行内容', 0, 1000),
    mk(2, 1, '第二行内容', 1000, 2000),
    mk(3, 2, '第三行内容', 2000, 3000),
  ]);
});

describe('修改操作 + undo', () => {
  it('改字 → undo', async () => {
    const before = await snapshot();
    await editText(2, '改过的内容');
    expect((await db.lines.get(2))!.text).toBe('改过的内容');
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });

  it('打标签 → undo', async () => {
    const before = await snapshot();
    await setLabel([2], 7);
    expect((await db.lines.get(2))!.labelId).toBe(7);
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });

  it('清标签 → undo', async () => {
    await setLabel([2], 7);
    await undo(1); // 撤销打标签
    const before = await snapshot();
    await setLabel([2], null);
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });

  it('拆行 → undo', async () => {
    const before = await snapshot();
    await splitLine(2, 2);
    expect(await db.lines.where('videoId').equals(1).count()).toBe(4);
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });

  it('合并到上一行 → undo', async () => {
    const before = await snapshot();
    await mergeWithPrev(3);
    expect(await db.lines.where('videoId').equals(1).count()).toBe(2);
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });

  it('删除 → undo', async () => {
    const before = await snapshot();
    await deleteLine(2);
    expect(await db.lines.where('videoId').equals(1).count()).toBe(2);
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });

  it('恢复原文 → undo', async () => {
    await editText(2, '改过的内容');
    await undo(1);
    const before = await snapshot();
    await editText(2, '再改一次');
    await revertLine(2, 'asr');
    expect((await db.lines.get(2))!.text).toBe('第二行内容');
    expect((await db.lines.get(2))!.edited).toBe(false);
    await undo(1); // 撤销 revert
    expect((await db.lines.get(2))!.text).toBe('再改一次');
    await undo(1); // 撤销 editText
    expect(await snapshot()).toEqual(before);
  });

  it('连续多步逐步撤销', async () => {
    const before = await snapshot();
    await editText(1, 'a');
    await editText(2, 'b');
    await deleteLine(3);
    await undo(1);
    await undo(1);
    await undo(1);
    expect(await snapshot()).toEqual(before);
  });
});
