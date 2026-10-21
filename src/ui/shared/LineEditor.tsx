// 行卡片列表 + 键盘操作（侧边栏与全屏页共用）
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  copyText, getLines, labelMap, playerSeek, sendToBackground, subscribePlayerTime, toast,
} from './api';
import {
  editText, setLabel, splitLine, mergeWithPrev, deleteLine, revertLine, undo, ManualEditError,
} from '../../core/lines';
import { formatLines, fmtTime, type CopyFormat } from '../../core/export';
import type { LabelRecord, LineRecord, VideoRecord } from '../../core/types';

interface Props {
  video: VideoRecord;
  compact?: boolean;
  copyFormat?: CopyFormat;
  onToast?: (s: string) => void;
  onFocusSearch?: () => void;
}

const isComposing = (e: React.KeyboardEvent) =>
  e.nativeEvent.isComposing || (e.nativeEvent as any).keyCode === 229;

export function LineEditor({ video, compact, copyFormat = 'text', onToast }: Props) {
  const [lines, setLines] = useState<LineRecord[]>([]);
  const [labels, setLabels] = useState<Map<number, LabelRecord>>(new Map());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number>(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTextVal, setEditTextVal] = useState('');
  const [playingMs, setPlayingMs] = useState<number | null>(null);
  const [labelFor, setLabelFor] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 一次编辑会话只提交一次（按键与失焦都会触发提交，用它去重）
  const committedRef = useRef(false);
  const pendingAction = useRef<{ kind: 'save' | 'split' | 'merge'; offset?: number }>({ kind: 'save' });

  const say = useCallback((s: string) => toast(s, onToast), [onToast]);

  const reload = useCallback(async () => {
    setLines(await getLines(video.id!));
    setLabels(await labelMap());
  }, [video.id]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const un = subscribePlayerTime((awemeId, ms) => {
      if (awemeId === video.contentId) setPlayingMs(ms);
    });
    return un;
  }, [video.contentId]);

  useEffect(() => {
    if (editingId != null) {
      committedRef.current = false;
      pendingAction.current = { kind: 'save' };
      editRef.current?.focus();
      const el = editRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length); // 光标放行尾
    }
  }, [editingId]);

  /** 编辑会话提交（按键路径与失焦路径共用，只生效一次） */
  const commitEdit = (lineId: number, text: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const action = pendingAction.current;
    pendingAction.current = { kind: 'save' };
    setEditingId(null);
    if (action.kind === 'split') {
      void doSplit(lineId, action.offset ?? text.length).catch((e: any) => say(String(e?.message ?? e)));
    } else if (action.kind === 'merge') {
      void doEdit(lineId, text).then(() => doMerge(lineId)).catch((e: any) => say(String(e?.message ?? e)));
    } else {
      void doEdit(lineId, text);
    }
  };

  const currentIdx = useMemo(() => {
    if (playingMs == null) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startMs <= playingMs) idx = i;
      else break;
    }
    return idx;
  }, [playingMs, lines]);

  const selectedLines = useMemo(() => lines.filter((l) => sel.has(l.id!)), [lines, sel]);

  // ---------- 操作 ----------
  const doEdit = async (id: number, text: string) => {
    await editText(id, text);
    await reload();
  };
  const doLabel = async (ids: number[], labelId: number | null) => {
    if (ids.length === 0) return;
    await setLabel(ids, labelId);
    await reload();
  };
  const doSplit = async (id: number, offset: number) => {
    await splitLine(id, offset);
    await reload();
  };
  const doMerge = async (id: number) => {
    try {
      await mergeWithPrev(id);
      await reload();
    } catch (e: any) {
      say(String(e?.message ?? e));
    }
  };
  const doDelete = async (ids: number[]) => {
    for (const id of ids) await deleteLine(id);
    setSel(new Set());
    await reload();
  };
  const doRevert = async (id: number) => {
    await revertLine(id);
    await reload();
  };
  const doUndo = async () => {
    await undo(video.id!);
    await reload();
    say('已撤销');
  };

  const copyLines = (ls: LineRecord[]) => {
    if (ls.length === 0) return;
    copyText(formatLines(ls, copyFormat, labels));
    say(`已复制 ${ls.length} 行`);
  };

  // ---------- 键盘 ----------
  const moveSel = (delta: number, extend: boolean) => {
    if (lines.length === 0) return;
    const cur = anchor ?? 0;
    const next = Math.max(0, Math.min(lines.length - 1, cur + delta));
    setAnchor(next);
    if (extend) {
      const s = new Set(sel);
      s.add(lines[next].id!);
      setSel(s);
    } else {
      setSel(new Set([lines[next].id!]));
    }
    document.querySelector(`[data-line-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return; // 中文输入法组词时交给输入法

    const editing = editingId != null;
    const key = e.key;

    if (editing) {
      if (key === 'Escape') {
        e.preventDefault();
        // textarea 自己的 Escape 已提交过，这里走同一个提交口（幂等）
        pendingAction.current = { kind: 'save' };
        commitEdit(editingId!, editTextVal);
      }
      return; // 编辑中的 Enter/Backspace 由 textarea 自己处理
    }

    const selIds = [...sel];
    const firstSel = lines.findIndex((l) => sel.has(l.id!));

    switch (true) {
      case key === 'ArrowUp' || key === 'k':
        e.preventDefault(); moveSel(-1, e.shiftKey); break;
      case key === 'ArrowDown' || key === 'j':
        e.preventDefault(); moveSel(1, e.shiftKey); break;
      case key === 'Enter': {
        e.preventDefault();
        const line = lines[anchor];
        if (line) {
          setEditingId(line.id!);
          setEditTextVal(line.text);
          setSel(new Set([line.id!]));
        }
        break;
      }
      case /^[1-9]$/.test(key): {
        e.preventDefault();
        const label = [...labels.values()].find((l) => l.hotkey === Number(key) && !l.archived);
        if (label && selIds.length) void doLabel(selIds, label.id!);
        break;
      }
      case key === '0':
        e.preventDefault();
        if (selIds.length) void doLabel(selIds, null);
        break;
      case key === 'c' || ((e.ctrlKey || e.metaKey) && key === 'c' && !editing):
        if (e.ctrlKey || e.metaKey || key === 'c') {
          e.preventDefault();
          copyLines(selectedLines.length ? selectedLines : lines.slice(anchor, anchor + 1));
        }
        break;
      case (e.ctrlKey || e.metaKey) && key.toLowerCase() === 'a':
        e.preventDefault(); setSel(new Set(lines.map((l) => l.id!))); break;
      case (e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z':
        e.preventDefault(); void doUndo(); break;
      case key === 'Delete' || key === 'Backspace':
        e.preventDefault();
        if (selIds.length) void doDelete(selIds);
        break;
      case key === ' ':
        e.preventDefault();
        if (lines[anchor]) void playerSeek(video.contentId, lines[anchor].startMs);
        break;
      case key === 'p':
        e.preventDefault();
        if (lines[anchor]) void playerSeek(video.contentId, lines[anchor].startMs);
        break;
      case key === '?':
        e.preventDefault(); setHelp(true); break;
      case key === 'Escape':
        setHelp(false); break;
      default:
        break;
    }
    void firstSel;
  };

  // 编辑态 textarea 的按键：Enter 拆行 / Esc 保存 / 行首 Backspace 合并
  const onEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return;
    const el = e.currentTarget;
    const lineId = editingId!;
    if (e.key === 'Escape') {
      e.preventDefault();
      pendingAction.current = { kind: 'save' };
      commitEdit(lineId, el.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pendingAction.current = { kind: 'split', offset: el.selectionStart };
      commitEdit(lineId, el.value);
    } else if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      pendingAction.current = { kind: 'merge' };
      commitEdit(lineId, el.value);
    }
  };

  // ---------- 渲染 ----------
  return (
    <div className="line-list" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
      {lines.length === 0 && <div className="empty">还没有识别结果</div>}
      {lines.map((line, i) => {
        const label = line.labelId != null ? labels.get(line.labelId) : undefined;
        const isEditing = editingId === line.id;
        const isPlaying = currentIdx === i;
        return (
          <div
            key={line.id}
            data-line-idx={i}
            className={`line-card${sel.has(line.id!) ? ' selected' : ''}${isPlaying ? ' playing' : ''}`}
            onClick={() => {
              setAnchor(i);
              setSel(new Set([line.id!]));
            }}
          >
            <span className="ts" onClick={(e) => { e.stopPropagation(); void playerSeek(video.contentId, line.startMs); }}>
              {fmtTime(line.startMs)}
            </span>
            {line.edited && <span className="edited-dot" title="手动修改过" />}
            <div className="text">
              {isEditing ? (
                <textarea
                  ref={editRef}
                  value={editTextVal}
                  onChange={(e) => setEditTextVal(e.target.value)}
                  onKeyDown={onEditKeyDown}
                  onBlur={() => commitEdit(line.id!, editTextVal)}
                />
              ) : (
                <span
                  onDoubleClick={() => {
                    setEditingId(line.id!);
                    setEditTextVal(line.text);
                  }}
                >
                  {line.text}
                </span>
              )}
              {(line.textAi && line.textAi !== line.textAsr) && (
                <button className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); void doRevert(line.id!); }}>
                  恢复原文
                </button>
              )}
            </div>
            <div
              className="label-chip"
              title={label ? `标签：${label.name}（点击改）` : '打标签'}
              style={label ? { background: label.color, borderStyle: 'solid', borderColor: label.color } : undefined}
              onClick={(e) => {
                e.stopPropagation();
                setLabelFor(labelFor === line.id ? null : line.id!);
              }}
            />
            <div className="ops">
              <button title="复制这行" onClick={(e) => { e.stopPropagation(); copyLines([line]); }}>⧉</button>
              {!compact && (
                <button title="删除" onClick={(e) => { e.stopPropagation(); void doDelete([line.id!]); }}>✕</button>
              )}
            </div>

            {labelFor === line.id && (
              <div style={{ position: 'absolute', zIndex: 30, right: 40, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                {[...labels.values()].filter((l) => !l.archived).map((l) => (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '2px 4px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLabelFor(null);
                      void doLabel([line.id!], l.id!);
                    }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: l.color }} />
                    {l.name} <span className="hint">{l.hotkey}</span>
                  </div>
                ))}
                <div style={{ cursor: 'pointer', padding: '2px 4px', color: 'var(--fg-2)' }}
                  onClick={(e) => { e.stopPropagation(); setLabelFor(null); void doLabel([line.id!], null); }}>
                  清除标签
                </div>
              </div>
            )}
          </div>
        );
      })}

      {help && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 50, display: 'grid', placeItems: 'center' }}
          onClick={() => setHelp(false)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 10, padding: 18 }} onClick={(e) => e.stopPropagation()}>
            <table className="help-table">
              <tbody>
                <tr><td>↑ ↓ / k j</td><td>上下移动选中行</td></tr>
                <tr><td>Shift + ↑ ↓</td><td>扩展多选</td></tr>
                <tr><td>Enter</td><td>编辑（编辑中 Enter=拆行，Esc=保存）</td></tr>
                <tr><td>行首 Backspace</td><td>合并到上一行</td></tr>
                <tr><td>1–9 / 0</td><td>打标签 / 清标签</td></tr>
                <tr><td>c</td><td>复制选中行</td></tr>
                <tr><td>Ctrl+A / Delete</td><td>全选 / 删除</td></tr>
                <tr><td>Space / p</td><td>从选中行播放</td></tr>
                <tr><td>Ctrl+Z</td><td>撤销</td></tr>
                <tr><td>?</td><td>本帮助</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export { ManualEditError, sendToBackground };
