// 全屏页视图：视频（编辑）/ 素材库 / 设置
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LineEditor } from '../shared/LineEditor';
import { StageProgress } from '../shared/StageProgress';
import {
  copyText, downloadTextFile, getLines, labelMap, listLabels, listVideos, sendToBackground, toast,
} from '../shared/api';
import {
  exportAll, exportLibrary, exportVideo, formatLines, fmtTime, sourceHeader, type CopyFormat, type VideoExportFormat,
} from '../../core/export';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '../../core/settings';
import { lexiconStats, mineLexicon } from '../../core/lexicon';
import {
  clearModels, downloadAllModels, hasBundledModel, hasModels, importModelFile, modelSizes, testModelUrls, type DownloadProgress,
} from '../../core/models';
import { db } from '../../core/db';
import type { LabelRecord, LineRecord, VideoRecord } from '../../core/types';

type ToastFn = (s: string) => void;

const STAGE_LABEL: Record<string, string> = {
  capture: '读取作品', download: '下载音频', decode: '解码', transcribe: '转写中',
  segment: '分行', llm: 'AI 校对', ready: '完成',
};

// ============ 视频页 ============
export function VideosView({ onToast }: { onToast: ToastFn }) {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [labels, setLabels] = useState<Map<number, LabelRecord>>(new Map());
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const [paste, setPaste] = useState('');
  const [pasteTags, setPasteTags] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void (async () => {
      setVideos(await listVideos());
      setLabels(await labelMap());
      setSettings(await getSettings());
    })();
  }, [tick, currentId]);

  useEffect(() => {
    const onMsg = (m: any) => { if (m?.type === 'job:changed') setTick((t) => t + 1); };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const filtered = useMemo(() => videos.filter((v) => {
    if (stateFilter && v.state !== stateFilter) return false;
    if (tagFilter && !v.tags.includes(tagFilter)) return false;
    if (search) {
      const hay = `${v.title} ${v.authorName} ${v.description}`;
      if (!hay.toLowerCase().includes(search.toLowerCase())) return false;
    }
    return true;
  }), [videos, search, stateFilter, tagFilter]);

  const current = videos.find((v) => v.id === currentId) ?? null;
  const allTags = useMemo(() => [...new Set(videos.flatMap((v) => v.tags))], [videos]);

  useEffect(() => { setNote(current?.note ?? ''); }, [current?.id]); // eslint-disable-line

  const ingest = async () => {
    if (!paste.trim()) return;
    const r = await sendToBackground({
      type: 'ingest:text',
      payload: { text: paste, tags: pasteTags.split(/[,，\s]+/).filter(Boolean) },
    });
    if (r?.error) onToast(r.error);
    else {
      onToast(`已加入 ${r?.count ?? 1} 条`);
      setPaste('');
      setTick((t) => t + 1);
    }
  };

  const doExport = async (fmt: VideoExportFormat) => {
    if (!current) return;
    const lines = await getLines(current.id!);
    const file = exportVideo(current, lines, fmt, labels);
    downloadTextFile(file.filename, file.content, file.mime);
    onToast(`已导出 ${file.filename}`);
  };

  const doExportAll = async () => {
    const file = exportAll(await listVideos(), await db.lines.toArray(), await listLabels());
    downloadTextFile(file.filename, file.content, file.mime);
    onToast('已导出全部数据');
  };

  const doImportAll = async (file: File) => {
    const text = await file.text();
    const { parseImportAll } = await import('../../core/export');
    const data = parseImportAll(text);
    let imported = 0, skipped = 0;
    for (const v of data.videos) {
      const dup = await db.videos.where('[platform+contentId]').equals([v.platform, v.contentId]).first();
      if (dup) { skipped++; continue; }
      const id = await db.videos.add({ ...v, id: undefined } as VideoRecord);
      const lines = data.lines.filter((l) => l.videoId === v.id);
      await db.lines.bulkAdd(lines.map((l) => ({ ...l, id: undefined, videoId: id as number })));
      imported++;
    }
    for (const l of data.labels) {
      if (!(await db.labels.where('name').equals(l.name).first())) await db.labels.add({ ...l, id: undefined });
    }
    onToast(`导入完成：新增 ${imported} 条，跳过已存在 ${skipped} 条`);
    setTick((t) => t + 1);
  };

  return (
    <div className="app-cols">
      {/* 左：列表 */}
      <div className="app-col" style={{ padding: 12 }}>
        <div className="paste-box">
          <textarea placeholder="粘贴分享口令 / 链接 / 作品 ID…" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="paste-row">
            <input placeholder="视频标签（可选）" value={pasteTags} onChange={(e) => setPasteTags(e.target.value)} />
            <button className="primary" onClick={() => void ingest()}>提取</button>
          </div>
        </div>
        <div className="filters">
          <input placeholder="搜索标题/作者/简介" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">全部状态</option>
            <option value="done">完成</option>
            <option value="failed">失败</option>
            <option value="queued">排队</option>
            <option value="running">处理中</option>
            <option value="skipped">跳过</option>
            <option value="waiting-user">等待用户</option>
          </select>
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="">全部标签</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {filtered.map((v) => (
          <div key={v.id} className={`v-item${v.id === currentId ? ' active' : ''}`} onClick={() => setCurrentId(v.id!)}>
            <div className="t">{v.title || v.contentId || '(未命名)'}</div>
            <div className="m">
              <span className={`badge ${v.state}`}>{STAGE_LABEL[v.stage] ?? v.stage}</span>
              {v.durationMs > 0 && <span>{fmtTime(v.durationMs)}</span>}
              {v.tags.map((t) => <span key={t}>#{t}</span>)}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="empty">没有视频</div>}
      </div>

      {/* 中：编辑器 */}
      <div className="app-col" style={{ padding: 12 }}>
        {!current && <div className="empty">左侧选一条视频</div>}
        {current && (
          <>
            <div className="paste-row" style={{ marginBottom: 10, gap: 6 }}>
              <select
                title="格式：复制和导出都用这个"
                value={settings?.copyFormat ?? 'text'}
                onChange={(e) => void saveSettings({ copyFormat: e.target.value as CopyFormat }).then(setSettings)}
              >
                <option value="text">纯文本</option>
                <option value="text_ts">带时间轴</option>
              </select>
              <button onClick={async () => {
                const lines = await getLines(current.id!);
                if (!lines.length) { onToast('没有识别结果可复制（这条视频没有转写出文字）'); return; }
                const body = formatLines(lines, settings?.copyFormat ?? 'text', labels);
                copyText(settings?.copyWithSource ? sourceHeader(current) + body : body);
                onToast(`已复制 ${lines.length} 行`);
              }}>复制</button>
              <button onClick={async () => {
                const lines = await getLines(current.id!);
                if (!lines.length) { onToast('没有识别结果可导出（这条视频没有转写出文字）'); return; }
                const fmt: VideoExportFormat = (settings?.copyFormat ?? 'text') === 'text_ts' ? 'txt_ts' : 'txt';
                const file = exportVideo(current, lines, fmt, labels);
                downloadTextFile(file.filename, file.content, file.mime);
                onToast(`已导出 ${file.filename}`);
              }}>导出</button>
              <button onClick={() => void doExport('json')}>导出 JSON</button>
              <button onClick={() => void doExportAll()}>导出全部</button>
              <label className="hint" style={{ cursor: 'pointer' }}>
                导入
                <input type="file" accept="application/json" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImportAll(f); }} />
              </label>
            </div>
            {current.state === 'done'
              ? <LineEditor video={current} copyFormat="text" onToast={onToast} />
              : (
                <div>
                  <StageProgress video={current} />
                  <div className="empty" style={{ paddingTop: 20 }}>
                    <div>状态：{STAGE_LABEL[current.stage] ?? current.stage}（{current.state}）</div>
                    {current.errorMessage && (
                      <div style={{ color: current.state === 'failed' ? 'var(--fail)' : 'var(--fg-2)', marginTop: 8 }}>
                        {current.errorMessage}
                      </div>
                    )}
                    {['failed', 'skipped', 'waiting-user'].includes(current.state) && (
                      <div style={{ marginTop: 10 }}>
                        <button className="primary" onClick={() => void sendToBackground({ type: 'video:action', payload: { action: 'retry', videoId: current.id } }).then(() => setTick((t) => t + 1))}>重试</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
          </>
        )}
      </div>

      {/* 右：视频信息 */}
      <div className="app-col" style={{ padding: 12 }}>
        {!current && <div className="hint">视频信息</div>}
        {current && (
          <>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{current.title || '(无标题)'}</div>
            <div className="hint" style={{ marginBottom: 6 }}>
              作者：{current.authorName || '未知'}　时长：{fmtTime(current.durationMs)}
            </div>
            <div className="hint" style={{ marginBottom: 6 }}>
              话题：{current.platformTags.length ? current.platformTags.map((t) => `#${t}`).join(' ') : '无'}
            </div>
            <div className="hint" style={{ marginBottom: 6 }}>
              <a href={current.webUrl} target="_blank" rel="noreferrer">打开原作品 ↗</a>
            </div>
            <div className="hint" style={{ marginBottom: 6 }}>视频标签（逗号分隔）：</div>
            <input
              style={{ width: '100%', marginBottom: 10 }}
              defaultValue={current.tags.join(',')}
              key={current.id}
              onBlur={async (e) => {
                const tags = e.target.value.split(/[,，\s]+/).filter(Boolean);
                await db.videos.update(current.id!, { tags, updatedAt: Date.now() });
                setTick((t) => t + 1);
              }}
            />
            <div className="hint" style={{ marginBottom: 6 }}>备注：</div>
            <textarea
              style={{ width: '100%', minHeight: 80 }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={async () => {
                await db.videos.update(current.id!, { note, updatedAt: Date.now() });
                onToast('备注已保存');
              }}
            />
            <div style={{ marginTop: 14 }}>
              <button className="ghost" style={{ color: 'var(--fail)' }}
                onClick={() => {
                  if (confirm('删除这条视频的全部记录？')) {
                    void sendToBackground({ type: 'video:action', payload: { action: 'delete', videoId: current.id } })
                      .then(() => { setCurrentId(null); setTick((t) => t + 1); });
                  }
                }}>删除这条视频</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============ 素材库 ============
export function LibraryView({ onToast }: { onToast: ToastFn }) {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [labels, setLabels] = useState<Map<number, LabelRecord>>(new Map());
  const [labelFilter, setLabelFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [author, setAuthor] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<{ video: VideoRecord; line: LineRecord }[]>([]);

  useEffect(() => {
    void (async () => {
      const vs = await listVideos();
      const lm = await labelMap();
      const allLines = await db.lines.toArray();
      setVideos(vs);
      setLabels(lm);
      const byId = new Map(vs.map((v) => [v.id!, v]));
      setRows(allLines
        .map((line) => ({ video: byId.get(line.videoId)!, line }))
        .filter((r) => r.video));
    })();
  }, []);

  const filtered = useMemo(() => rows.filter((r) => {
    if (labelFilter && (labels.get(r.line.labelId ?? -1)?.name ?? '') !== labelFilter) return false;
    if (tagFilter && !r.video.tags.includes(tagFilter)) return false;
    if (author && !r.video.authorName.includes(author)) return false;
    if (keyword && !r.line.text.toLowerCase().includes(keyword.toLowerCase())) return false;
    return true;
  }), [rows, labelFilter, tagFilter, keyword, author, labels]);

  const allTags = useMemo(() => [...new Set(videos.flatMap((v) => v.tags))], [videos]);

  const doExport = (data: typeof filtered) => {
    const file = exportLibrary(data, 'csv', labels);
    downloadTextFile(file.filename, file.content, file.mime);
    onToast(`已导出 ${file.filename}`);
  };

  return (
    <div style={{ padding: 16 }}>
      <div className="filters">
        <select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)}>
          <option value="">全部结构标签</option>
          {[...labels.values()].filter((l) => !l.archived).map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
        </select>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
          <option value="">全部视频标签</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="作者" value={author} onChange={(e) => setAuthor(e.target.value)} />
        <input placeholder="关键词（搜行文本）" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <span className="hint">{filtered.length} 条</span>
        <button onClick={() => {
          copyText(formatLines(filtered.map((r) => r.line), 'text', labels));
          onToast(`已复制 ${filtered.length} 行`);
        }}>复制</button>
        <button onClick={() => doExport(filtered)}>导出 CSV</button>
      </div>

      {filtered.map((r, i) => {
        const label = r.line.labelId != null ? labels.get(r.line.labelId) : undefined;
        return (
          <div key={`${r.line.id}`} className="lib-row">
            <input type="checkbox" checked={sel.has(r.line.id!)} onChange={(e) => {
              const s = new Set(sel);
              if (e.target.checked) s.add(r.line.id!); else s.delete(r.line.id!);
              setSel(s);
            }} />
            <span style={{ width: 10, height: 18, borderRadius: 3, background: label?.color ?? 'var(--bg-hover)', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{r.line.text}</span>
            <span className="meta">
              {r.video.title.slice(0, 24) || r.video.contentId} · {r.video.authorName} · [{fmtTime(r.line.startMs)}]
            </span>
          </div>
        );
      })}
      {filtered.length === 0 && <div className="empty">没有匹配的句子</div>}
    </div>
  );
}

// ============ 设置 ============
export function SettingsView({ onToast }: { onToast: ToastFn }) {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  const [modelSizeMap, setModelSizes] = useState<Record<string, number>>({});
  const [bundled, setBundled] = useState(false);
  const [learnedPairs, setLearnedPairs] = useState<{ wrong: string; right: string }[]>([]);

  useEffect(() => {
    void getSettings().then(setS);
    void hasModels().then(setHasModel);
    void modelSizes().then(setModelSizes);
    void hasBundledModel().then(setBundled);
    void (async () => {
      const edits = await db.edits.toArray();
      setLearnedPairs(mineLexicon(edits));
    })();
  }, []);

  const save = async (patch: Partial<Settings>) => {
    setS(await saveSettings(patch));    onToast('已保存');
  };

  // 模型文件真实大小（MB）与完整性判断
  const modelSizesText = Object.keys(modelSizeMap).length
    ? Object.entries(modelSizeMap).map(([k, v]) => `${k} ${(v / 1048576).toFixed(1)}MB`).join('，')
    : '';
  const sizesOk = (modelSizeMap.model ?? 0) >= 150 * 1024 * 1024;

  /** 一键诊断：环境 + 模型 + 引擎自检 + 全部任务记录，导出 txt */
  const doDiag = async () => {
    const models = await hasModels();
    const selftest = await sendToBackground({ type: 'selftest' });
    const videos = await db.videos.orderBy('createdAt').reverse().toArray();
    const asrResults = await db.asrResults.toArray();
    const asrMap = new Map(asrResults.map((r) => [r.videoId, r]));
    const hostOf = (u: string) => { try { return new URL(u).host; } catch { return (u || '-').slice(0, 24); } };
    const report = [
      'TikTrans 诊断报告',
      `时间：${new Date().toLocaleString()}`,
      `扩展版本：${chrome.runtime.getManifest().version}`,
      `浏览器：${navigator.userAgent}`,
      `模型状态：${models ? '已下载' : '未下载'}`,
      `引擎自检：${selftest?.ok ? '通过' : '失败'} — ${selftest?.detail ?? '无响应'}`,
      `设置：${JSON.stringify({ lineMode: s.lineMode, maxLineChars: s.maxLineChars, pauseBreakMs: s.pauseBreakMs, maxDurationMin: s.maxDurationMin, audioKeepDays: s.audioKeepDays, model: s.model })}`,
      '',
      `任务记录（${videos.length} 条）：`,
      ...videos.map((v) => {
        const asr = asrMap.get(v.id!);
        const asrInfo = asr
          ? `转写=${asr.result?.length ?? 0}段/${(asr.result ?? []).reduce((a: number, s: any) => a + (s.text || '').length, 0)}字`
          : '转写=无记录';
        return `#${v.id} [${v.state}/${v.stage}] 作品ID=${v.contentId || '(空)'} 标题="${(v.title || '').slice(0, 24)}" 时长=${(v.durationMs / 1000).toFixed(1)}s ${asrInfo} 备注="${v.note || '-'}" 错误="${v.errorMessage || '-'}" 媒体域名=${(v.mediaUrls ?? []).map(hostOf).join(' | ') || '-'}`;
      }),
    ];
    downloadTextFile(`tiktrans-diag-${new Date().toISOString().slice(0, 10)}.txt`, report.join('\n'), 'text/plain');
    onToast('诊断报告已导出');
  };

  /** 清理永远等不出结果的占位记录 */
  const doClean = async () => {
    const all = await db.videos.toArray();
    const stuck = all.filter((v) => v.state === 'waiting-user' || (v.state === 'failed' && !v.contentId));
    if (!stuck.length) { onToast('没有卡住的记录'); return; }
    if (confirm(`删除 ${stuck.length} 条卡住的记录？（无作品数据的等待/失败记录）`)) {
      for (const v of stuck) {
        await sendToBackground({ type: 'video:action', payload: { action: 'delete', videoId: v.id } });
      }
      onToast(`已清理 ${stuck.length} 条，切到「视频」页查看`);
    }
  };

  return (
    <div className="settings-form" style={{ padding: 16 }}>
      <h3>转写</h3>
      <label>成行方式
        <select value={s.lineMode} onChange={(e) => void save({ lineMode: e.target.value as Settings['lineMode'] })}>
          <option value="sentence">整句（默认）</option>
          <option value="clause">短句</option>
        </select>
      </label>
      <label>每行最多字数（不算标点）
        <input type="number" defaultValue={s.maxLineChars} onBlur={(e) => void save({ maxLineChars: Number(e.target.value) || 60 })} />
      </label>
      <label>每行最长时长（秒）
        <input type="number" defaultValue={s.maxLineSec} onBlur={(e) => void save({ maxLineSec: Number(e.target.value) || 20 })} />
      </label>
      <label>换行停顿（毫秒，短句模式用）
        <input type="number" defaultValue={s.pauseBreakMs} onBlur={(e) => void save({ pauseBreakMs: Number(e.target.value) || 1200 })} />
      </label>
      <label>浏览器内引擎的时长上限（分钟，0 = 不限）
        <input type="number" defaultValue={s.maxDurationMin} onBlur={(e) => void save({ maxDurationMin: Number(e.target.value) || 30 })} />
      </label>
      <label>音频保留天数（0 = 转写完就删）
        <input type="number" defaultValue={s.audioKeepDays} onBlur={(e) => void save({ audioKeepDays: Number(e.target.value) || 0 })} />
      </label>

      <h3>语音模型（用默认地址就能下载，不用改）</h3>
      <div className="hint">下面三个是模型文件的下载地址，默认已填好直接点「下载模型」即可；以后要换成自己托管的地址时再改这里。</div>
      <div className="hint" style={{ color: 'var(--fg-3)' }}>
        当前用 SenseVoice int8 2024-07-17 版（228MB，带标点，规格指定版本）。
        识别引擎跑在 WebAssembly 里，常驻内存约 600MB（模型 228MB + 推理缓冲），
        加上音频副本，每条视频大约 1GB 上下——这是浏览器内离线识别的固有成本。
        想省内存：连续转写多条时内存是复用的（不会每条都涨），关掉浏览器即释放。
      </div>
      <label>SenseVoice 模型（model.int8.onnx）
        <input value={s.model.modelUrl} onChange={(e) => setS({ ...s, model: { ...s.model, modelUrl: e.target.value } })} />
      </label>
      <label>tokens.txt
        <input value={s.model.tokensUrl} onChange={(e) => setS({ ...s, model: { ...s.model, tokensUrl: e.target.value } })} />
      </label>
      <label>Silero VAD（silero_vad.onnx）
        <input value={s.model.vadUrl} onChange={(e) => setS({ ...s, model: { ...s.model, vadUrl: e.target.value } })} />
      </label>
      <label>模型 SHA-256（可选，空 = 不校验）
        <input value={s.model.modelSha256} onChange={(e) => setS({ ...s, model: { ...s.model, modelSha256: e.target.value } })} />
      </label>
      <div className="row">
        <button onClick={async () => {
          const r = await sendToBackground({ type: 'selftest' });
          onToast(r?.ok ? r.detail : `自检失败：${r?.detail ?? '无响应'}`);
        }}>引擎自检（不用视频，验证模型和识别器）</button>
        <button onClick={async () => {
          onToast('正在测试各个下载地址…');
          const rows = await testModelUrls(s.model);
          const bad = rows.filter((r) => !r.ok);
          const msg = rows.map((r) => `${r.ok ? '✅' : '❌'} ${r.key} ${r.url} → ${r.detail}`).join('\n');
          onToast(msg);
          console.log('[tiktrans] 下载源测试结果\n' + msg);
          if (bad.length === rows.length) onToast('所有地址都连不上 → 是网络/代理问题，不是扩展的问题');
        }}>测试下载源（看哪个地址能用）</button>
        <button onClick={() => void save({ model: s.model })}>保存模型地址</button>
        <button className="primary" disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            setProgress(null);
            try {
              await downloadAllModels(s.model, (p) => setProgress(p));
              await saveSettings({ onboarded: true });
              onToast('模型下载完成');
              setHasModel(true);
            } catch (e: any) {
              onToast(String(e?.message ?? e));
            } finally {
              setDownloading(false);
            }
          }}>
          {hasModel ? '重新下载模型' : '下载模型'}
        </button>
        <button disabled={downloading}
          onClick={async () => {            if (confirm('删除本地模型？下次使用需要重新下载。')) {
              await clearModels();
              await saveSettings({ onboarded: false });
              setHasModel(false);
              setModelSizes({});
              onToast('模型已删除');
            }
          }}>删除模型</button>
      </div>

      <h3>手动导入模型文件（网络下不动时的办法）</h3>
      <div className="hint">
        用浏览器/下载器把下面三个文件下下来（走你的代理，成功率更高），再分别选文件导入：
        <br />① <a href={s.model.modelUrl} target="_blank" rel="noreferrer">model.int8.onnx</a>（约 228MB）
        <br />② <a href={s.model.tokensUrl} target="_blank" rel="noreferrer">tokens.txt</a>（约 300KB）
        <br />③ <a href={s.model.vadUrl} target="_blank" rel="noreferrer">silero_vad.onnx</a>（约 630KB）
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {([
          ['model', '导入 model.int8.onnx'],
          ['tokens', '导入 tokens.txt'],
          ['vad', '导入 silero_vad.onnx'],
        ] as ['model' | 'tokens' | 'vad', string][]).map(([k, label]) => (
          <label key={k} className="hint" style={{ cursor: 'pointer' }}>
            {label}
            <input type="file" style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const size = await importModelFile(k, f);
                  onToast(`已导入 ${k}（${(size / 1048576).toFixed(1)}MB）`);
                  setHasModel(await hasModels());
                  setModelSizes(await modelSizes());
                } catch (err: any) {
                  onToast(`导入失败：${String(err?.message ?? err)}`);
                }
              }} />
          </label>
        ))}
      </div>
      {progress && (
        <div>
          <div className="progress"><div style={{ width: `${progress.total ? Math.round(progress.loaded / progress.total * 100) : 0}%` }} /></div>
          <div className="hint">{Math.round((progress.loaded / 1024 / 1024) * 10) / 10} MB{progress.total ? ` / ${Math.round((progress.total / 1024 / 1024) * 10) / 10} MB` : ''}
            <span className="hint"> （{progress.key}）{progress.phase ? ` — ${progress.phase}` : ''}</span></div>
        </div>
      )}
      <div className="hint">模型状态：{hasModel ? '已下载' : '未下载'}{bundled ? '（扩展自带，无需下载）' : ''}</div>
      {modelSizesText && <div className="hint">本地已存：{modelSizesText}</div>}
      {hasModel && !sizesOk && (
        <div className="hint" style={{ color: 'var(--fail)' }}>
          ⚠️ 已下载的模型文件不完整（主模型必须 ≥150MB），转写会失败。请点「重新下载模型」重新下载。
        </div>
      )}

      <h3>诊断与维护</h3>
      <div className="hint">遇到任何问题：点「导出诊断报告」，把生成的 txt 文件发给开发者即可，不需要截图。</div>
      <div className="row">
        <button className="primary" onClick={() => void doDiag()}>导出诊断报告</button>
        <button onClick={() => void doClean()}>清理卡住的记录</button>
      </div>
      <div className="hint">扩展版本：v{chrome.runtime.getManifest().version}</div>

      <h3>AI 校对（可选，二期功能，填了也不会在一期启用）</h3>
      <label>OpenAI 兼容接口地址
        <input value={s.llmBaseUrl} onChange={(e) => setS({ ...s, llmBaseUrl: e.target.value })} onBlur={() => void save({ llmBaseUrl: s.llmBaseUrl })} />
      </label>
      <label>Key
        <input type="password" value={s.llmKey} onChange={(e) => setS({ ...s, llmKey: e.target.value })} onBlur={() => void save({ llmKey: s.llmKey })} />
      </label>
      <label>模型名
        <input value={s.llmModel} onChange={(e) => setS({ ...s, llmModel: e.target.value })} onBlur={() => void save({ llmModel: s.llmModel })} />
      </label>

      <h3>复制</h3>
      <label>默认复制格式
        <select value={s.copyFormat} onChange={(e) => void save({ copyFormat: e.target.value as CopyFormat })}>
          <option value="text">纯文本</option>
          <option value="text_ts">带时间</option>
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={s.copyWithSource}
          onChange={(e) => void save({ copyWithSource: e.target.checked })} />
        复制时带上来源（标题/作者/视频链接）
      </label>
      <div className="hint">导出 txt 时始终会带上来源信息（视频链接放在文件顶部），不受这个开关影响。</div>

      <h3>易错词表（纠正同音字）</h3>      <div className="hint">
        语音模型对同音字无能为力（实测：SenseVoice 离线识别只支持 greedy 解码，没有更好的解码参数可调）。
        把常听错的词写在这里，转写后会自动替换。每行一条「错字=正字」，两个字要一样长，例如：
        <br />美誉=美玉　瓦丽=瓦砾　切懦=怯懦　真视=珍视
      </div>
      <textarea
        value={s.lexicon}
        placeholder={'美誉=美玉\n瓦丽=瓦砾\n切懦=怯懦'}
        style={{ width: '100%', minHeight: 90, fontFamily: 'inherit' }}
        onChange={(e) => setS({ ...s, lexicon: e.target.value })}
        onBlur={() => void save({ lexicon: s.lexicon })}
      />
      <div className="hint">
        已生效 {lexiconStats(s.lexicon).count} 条
        {lexiconStats(s.lexicon).sample ? `（例：${lexiconStats(s.lexicon).sample}）` : ''}
        · 词表在转写时生效，已经转写好的视频需要点「重试」才会重新纠正
      </div>
      <div className="hint">
        另外：你在编辑器里改过的字，系统会自动统计——<b>同一处改过 2 次以上</b>就自动当成词条，
        以后所有视频转写时自动纠正（{learnedPairs.length ? `目前学到 ${learnedPairs.length} 条：${learnedPairs.slice(0, 4).map((p) => `${p.wrong}→${p.right}`).join('、')}` : '目前还没学到'}）。
      </div>
    </div>
  );
}
