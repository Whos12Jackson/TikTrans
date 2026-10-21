// UI 共享：数据访问 + 浏览器能力封装
import { useEffect, useState } from 'react';
import { db } from '../../core/db';
import type { LabelRecord, LineRecord, VideoRecord } from '../../core/types';

// ---------- React 简易数据源 ----------
export function useLive<T>(loader: () => Promise<T>, deps: unknown[]): T | null {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loader().then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    const un = subscribeJobs(() => setTick((t) => t + 1));
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return data;
}

export function refreshAll(): void {
  window.dispatchEvent(new CustomEvent('tiktrans:refresh'));
}

/** 任务状态变化（后台广播）→ 刷新；播放进度不触发全量刷新（见 subscribePlayerTime） */
export function subscribeJobs(cb: () => void): () => void {
  const onMsg = (msg: any) => {
    if (msg?.type === 'job:changed') cb();
  };
  chrome.runtime.onMessage.addListener(onMsg);
  const onLocal = () => cb();
  window.addEventListener('tiktrans:refresh', onLocal);
  return () => {
    chrome.runtime.onMessage.removeListener(onMsg);
    window.removeEventListener('tiktrans:refresh', onLocal);
  };
}

/** 播放进度（用于高亮当前行） */
export function subscribePlayerTime(
  cb: (awemeId: string, ms: number, playing: boolean) => void,
): () => void {
  const onMsg = (msg: any) => {
    if (msg?.type === 'player:time') cb(msg.payload.awemeId, msg.payload.ms, msg.payload.playing);
  };
  chrome.runtime.onMessage.addListener(onMsg);
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}

// ---------- 数据读写 ----------
export async function listVideos(): Promise<VideoRecord[]> {
  return (await db.videos.orderBy('createdAt').reverse().toArray());
}
export async function getVideo(id: number): Promise<VideoRecord | undefined> {
  return db.videos.get(id);
}
export async function getLines(videoId: number): Promise<LineRecord[]> {
  return db.lines.where('videoId').equals(videoId).sortBy('idx');
}
export async function listLabels(): Promise<LabelRecord[]> {
  return db.labels.orderBy('sort').toArray();
}
export async function labelMap(): Promise<Map<number, LabelRecord>> {
  const labels = await listLabels();
  return new Map(labels.map((l) => [l.id!, l]));
}

// ---------- 动作 ----------
export async function sendToBackground(msg: unknown): Promise<any> {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));
}

export async function playerSeek(awemeId: string, ms: number): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['https://*.douyin.com/*', 'https://www.douyin.com/*'] });
  for (const tab of tabs) {
    if (tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { type: 'player:seek', payload: { awemeId, ms } }).catch(() => {});
    }
  }
}

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- 提示 ----------
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string, setToast?: (s: string) => void): void {
  if (setToast) {
    setToast(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(''), 1500);
  }
}
