// 侧边栏：粘贴框 + 当前视频状态 + 行卡片
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui.css';
import { LineEditor } from '../shared/LineEditor';
import { StageProgress } from '../shared/StageProgress';
import { copyText, downloadTextFile, listVideos, sendToBackground, toast } from '../shared/api';
import { exportVideo, formatLines, fmtTime, sourceHeader, type CopyFormat, type VideoExportFormat } from '../../core/export';
import { getSettings, saveSettings, type Settings } from '../../core/settings';
import { getLines, labelMap } from '../shared/api';
import type { VideoRecord } from '../../core/types';

const STAGE_LABEL: Record<string, string> = {
  capture: '读取作品', download: '下载音频', decode: '解码', transcribe: '转写中',
  segment: '分行', llm: 'AI 校对', ready: '完成',
};

function SidePanel() {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [paste, setPaste] = useState('');
  const [tags, setTags] = useState('');
  const [msg, setMsg] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tick, setTick] = useState(0);

  const reload = async () => {
    const vs = await listVideos();
    setVideos(vs);
    setSettings(await getSettings());
    setCurrentId((cur) => cur ?? vs[0]?.id ?? null);
  };

  useEffect(() => { void reload(); }, [tick]);

  useEffect(() => {
    const onMsg = (m: any) => {
      if (m?.type === 'job:changed') {
        setTick((t) => t + 1);
        // 新任务刚入队 / 任务完成：自动切到它，确保「点完看到的就是这条」
        const p = m.payload;
        if (p && ((p.stage === 'capture' && p.state === 'queued') || (p.state === 'done' && p.stage === 'ready'))) {
          setCurrentId(p.videoId);
        }
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const current = useMemo(() => videos.find((v) => v.id === currentId) ?? videos[0] ?? null, [videos, currentId]);

  const ingest = async () => {
    if (!paste.trim()) return;
    const r = await sendToBackground({
      type: 'ingest:text',
      payload: { text: paste, tags: tags.split(/[,，\s]+/).filter(Boolean) },
    });
    if (r?.error) toast(r.error, setMsg);
    else {
      toast(`已加入 ${r?.count ?? 1} 条`, setMsg);
      setPaste('');
      setCurrentId(null); // 落到最新一条（按创建时间倒序的第一条）
      setTick((t) => t + 1);
    }
  };

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="title">TikTrans</span>
        <span className="hint">口播逐行提取</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="全屏页" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('app.html') })}>⤡</button>
      </div>

      <div className="pane-body">
        <div className="paste-box">
          <textarea
            placeholder="粘贴分享口令 / 链接 / 作品 ID，可多条…"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <div className="paste-row">
            <input placeholder="视频标签（可选，逗号分隔）" value={tags} onChange={(e) => setTags(e.target.value)} />
            <button className="primary" onClick={() => void ingest()}>提取口播</button>
          </div>
        </div>

        {videos.length > 0 && (
          <div style={{ margin: '12px 0' }}>
            <select
              style={{ width: '100%' }}
              value={current?.id ?? ''}
              onChange={(e) => setCurrentId(Number(e.target.value))}
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {(v.title || v.contentId || '(未命名)').slice(0, 30)} · {v.state === 'done' ? '完成' : v.state === 'failed' ? '失败' : `${STAGE_LABEL[v.stage] ?? v.stage}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {current && (
          <>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600 }}>{current.title || current.contentId || '(未命名)'}</div>
              <div className="hint">
                {current.authorName && <span>{current.authorName} · </span>}
                {current.durationMs > 0 && <span>{fmtTime(current.durationMs)} · </span>}
                <span className={`badge ${current.state}`}>{STAGE_LABEL[current.stage] ?? current.stage}{current.state === 'running' ? '…' : ''}</span>
                {['failed', 'skipped', 'waiting-user'].includes(current.state) && (
                  <button className="ghost" onClick={() => void sendToBackground({ type: 'video:action', payload: { action: 'retry', videoId: current.id } }).then(() => setTick((t) => t + 1))}>
                    重试
                  </button>
                )}
              </div>
              {(current.state === 'failed' || current.state === 'skipped' || current.state === 'waiting-user') && current.errorMessage && (
                <div className="hint" style={{ color: current.state === 'failed' ? 'var(--fail)' : 'var(--fg-2)', marginTop: 4 }}>
                  {current.errorMessage}
                </div>
              )}
              {current.state !== 'done' && current.state !== 'failed' && <StageProgress video={current} />}
            </div>

            {current.state === 'done' && (
              <>
                <div className="paste-row" style={{ marginBottom: 10, gap: 6 }}>
                  <select
                    title="格式：复制和导出都用这个"
                    value={settings?.copyFormat ?? 'text'}
                    onChange={async (e) => {
                      const s = await saveSettings({ copyFormat: e.target.value as CopyFormat });
                      setSettings(s);
                    }}
                  >
                    <option value="text">纯文本</option>
                    <option value="text_ts">带时间</option>
                  </select>
                  <button onClick={async () => {
                    const lines = await getLines(current.id!);
                    if (!lines.length) { toast('没有识别结果可复制（这条视频没有转写出文字）', setMsg); return; }
                    const labels = await labelMap();
                    const body = formatLines(lines, settings?.copyFormat ?? 'text', labels);
                    const text = settings?.copyWithSource ? sourceHeader(current) + body : body;
                    copyText(text);
                    toast(`已复制 ${lines.length} 行`, setMsg);
                  }}>复制</button>
                  <button onClick={async () => {
                    const lines = await getLines(current.id!);
                    if (!lines.length) { toast('没有识别结果可导出（这条视频没有转写出文字）', setMsg); return; }
                    const labels = await labelMap();
                    const fmt: VideoExportFormat = (settings?.copyFormat ?? 'text') === 'text_ts' ? 'txt_ts' : 'txt';
                    const file = exportVideo(current, lines, fmt, labels);
                    downloadTextFile(file.filename, file.content, file.mime);
                    toast(`已导出 ${file.filename}`, setMsg);
                  }}>导出</button>
                </div>
                <LineEditor
                  video={current}
                  compact
                  copyFormat={settings?.copyFormat ?? 'text'}
                  onToast={setMsg}
                />
              </>
            )}
          </>
        )}

        {videos.length === 0 && (
          <div className="empty">还没有视频。<br />在抖音页面点「提取口播」，或在上面粘贴链接。</div>
        )}
      </div>
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<SidePanel />);
