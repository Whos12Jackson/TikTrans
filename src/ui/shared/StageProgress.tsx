// 阶段进度条：让「点完之后发生了啥」可见
import React, { useEffect, useState } from 'react';
import type { VideoRecord } from '../../core/types';

const STAGES: { key: string; label: string }[] = [
  { key: 'capture', label: '读取作品' },
  { key: 'download', label: '下载音频' },
  { key: 'decode', label: '解码' },
  { key: 'transcribe', label: '转写' },
  { key: 'segment', label: '分行' },
  { key: 'llm', label: 'AI 校对' },
  { key: 'ready', label: '完成' },
];

export function StageProgress({ video }: { video: VideoRecord }) {
  const [progress, setProgress] = useState(0);
  const [detail, setDetail] = useState('');

  useEffect(() => {
    const onMsg = (m: any) => {
      if (m?.type === 'job:changed' && m.payload?.videoId === video.id) {
        setProgress(m.payload.progress ?? 0);
        setDetail(m.payload.detail ?? '');
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [video.id]);

  const curIdx = STAGES.findIndex((s) => s.key === video.stage);
  const failed = video.state === 'failed';
  const done = video.state === 'done';

  return (
    <div style={{ margin: '8px 0' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {STAGES.map((s, i) => {
          const isDone = done || i < curIdx;
          const isActive = !done && i === curIdx;
          return (
            <span key={s.key} style={{
              fontSize: 12, padding: '2px 8px', borderRadius: 99,
              border: '1px solid var(--border)',
              background: isDone ? 'var(--bg-hover)' : isActive ? 'var(--accent-soft)' : 'transparent',
              color: isDone ? 'var(--fg-2)' : isActive ? 'var(--fg)' : 'var(--fg-3)',
              fontWeight: isActive ? 600 : 400,
            }}>
              {isDone ? '✓ ' : isActive ? (failed ? '✕ ' : '… ') : ''}{s.label}
            </span>
          );
        })}
      </div>
      {!done && !failed && video.stage === 'download' && (
        <div style={{ marginTop: 6 }}>
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 2 }}>
            下载音频中…{detail || (progress > 0 ? ` ${Math.round(progress * 100)}%` : '')}
          </div>
        </div>
      )}
      {!done && !failed && (video.stage === 'decode' || video.stage === 'transcribe') && (
        <div style={{ marginTop: 6 }}>
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 2 }}>
            转写中…{progress > 0 ? ` ${Math.round(progress * 100)}%` : '（启动识别引擎）'}
          </div>
        </div>
      )}
      {(video.state === 'queued' && video.stage === 'capture') && (
        <div className="hint" style={{ marginTop: 4 }}>已排队，等待处理…</div>
      )}
    </div>
  );
}
