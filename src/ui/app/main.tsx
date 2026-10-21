// 全屏页入口：首次引导 + 三个页签（视频 / 素材库 / 设置）
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui.css';
import { LibraryView, SettingsView, VideosView } from './views';
import { getSettings, saveSettings, DEFAULT_SETTINGS, type Settings } from '../../core/settings';
import { downloadAllModels, hasBundledModel, hasModels, importModelFile, modelSizes, type DownloadProgress } from '../../core/models';

function Onboarding({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  void getSettings().then(setSettings);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 100, overflow: 'auto', padding: 40 }}>
      <div style={{ maxWidth: 560, margin: '40px auto' }}>
        <h1 style={{ fontSize: 26 }}>TikTrans · 抖音口播逐行提取</h1>
        <p>在抖音页面点「提取口播」，或粘贴分享链接，把视频口播转成「一句一行、带时间戳」的文本，可以逐行修改、复制、打标签。</p>
        <ul style={{ color: 'var(--fg-2)', lineHeight: 2 }}>
          <li>全部处理在你自己的浏览器里完成，不经过任何服务器。</li>
          <li>第一次使用需要下载语音模型（一次性，之后可离线转写）。</li>
          <li>想要 AI 校对，可以在「设置」里填 OpenAI 兼容接口；不填不影响其他功能。</li>
        </ul>

        <div style={{ marginTop: 24 }}>
          {!downloading && !progress && (
            <button className="primary" style={{ fontSize: 16, padding: '10px 22px' }}
              onClick={async () => {
                setDownloading(true);
                setError('');
                try {
                  const settings = await getSettings();
                  await downloadAllModels(settings.model, (p) => setProgress(p));
                  await saveSettings({ onboarded: true });
                  onDone();
                } catch (e: any) {
                  setError(String(e?.message ?? e));
                } finally {
                  setDownloading(false);
                }
              }}>
              下载语音模型（约 230 MB，一次性）
            </button>
          )}
          {(downloading || progress) && (
            <div>
              <div className="progress"><div style={{ width: `${progress?.total ? Math.round(progress.loaded / progress.total * 100) : 5}%` }} /></div>
              <div className="hint" style={{ marginTop: 6 }}>
                下载中… {progress ? `${Math.round(progress.loaded / 1024 / 1024)} MB${progress.total ? ` / ${Math.round(progress.total / 1024 / 1024)} MB` : ''}` : ''}
              </div>
            </div>
          )}
          {error && (
            <div style={{ color: 'var(--fail)', marginTop: 10 }}>
              {error}
              <div className="hint" style={{ marginTop: 6 }}>
                也可以直接点下面的链接用浏览器下载（走你的代理更稳），再回来手动导入：
                <br />
                <a href={settings.model.modelUrl} target="_blank" rel="noreferrer">model.int8.onnx（228MB）</a> ·
                <a href={settings.model.tokensUrl} target="_blank" rel="noreferrer">tokens.txt</a> ·
                <a href={settings.model.vadUrl} target="_blank" rel="noreferrer">silero_vad.onnx</a>
              </div>
            </div>
          )}

          {/* 网络下不动时的兜底：手动导入模型文件 */}
          <div style={{ marginTop: 24, padding: 14, border: '1px solid var(--border)', borderRadius: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>下载不动？手动导入模型文件</div>
            <div className="hint" style={{ lineHeight: 1.8 }}>
              用浏览器/下载器把三个文件下下来（走你的代理更稳），再分别选文件导入：<br />
              ① model.int8.onnx（约 228MB）② tokens.txt（约 300KB）③ silero_vad.onnx（约 630KB）<br />
              文件名相同即可，导入后自动校验大小。
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
              {([
                ['model', '选 model.int8.onnx'],
                ['tokens', '选 tokens.txt'],
                ['vad', '选 silero_vad.onnx'],
              ] as ['model' | 'tokens' | 'vad', string][]).map(([k, label]) => (
                <label key={k} className="hint" style={{ cursor: 'pointer' }}>
                  {label}
                  <input type="file" style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const size = await importModelFile(k, f);
                        setImportMsg(`已导入 ${k}（${(size / 1048576).toFixed(1)}MB）`);
                        const sizes = await modelSizes();
                        if (sizes.model && sizes.tokens && sizes.vad) {
                          setImportMsg('三个文件都齐了，正在进入…');
                          await saveSettings({ onboarded: true });
                          onDone();
                        }
                      } catch (err: any) {
                        setImportMsg(`导入失败：${String(err?.message ?? err)}`);
                      }
                    }} />
                </label>
              ))}
            </div>
            {importMsg && <div className="hint" style={{ marginTop: 8 }}>{importMsg}</div>}
          </div>
        </div>

        <div style={{ marginTop: 30 }}>
          <button className="ghost" onClick={onDone}>跳过，稍后再下（功能会不可用）</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<'videos' | 'library' | 'settings'>('videos');
  const [toastMsg, setToastMsg] = useState('');
  const [needOnboarding, setNeedOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      const models = await hasModels();
      const bundled = await hasBundledModel();   // 离线包自带模型 → 不用下载
      if (bundled) await saveSettings({ onboarded: true });
      setNeedOnboarding(!s.onboarded && !models && !bundled);
    })();
  }, []);

  const say = (s: string) => {
    setToastMsg(s);
    setTimeout(() => setToastMsg(''), 1500);
  };

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="title">TikTrans</span>
        <div className="tabs">
          <button className={tab === 'videos' ? 'active' : ''} onClick={() => setTab('videos')}>视频</button>
          <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>素材库</button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>设置</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'videos' && <div style={{ flex: 1, minHeight: 0 }}><VideosView onToast={say} /></div>}
        {tab === 'library' && <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><LibraryView onToast={say} /></div>}
        {tab === 'settings' && <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><SettingsView onToast={say} /></div>}
      </div>
      {toastMsg && <div className="toast">{toastMsg}</div>}
      {needOnboarding && <Onboarding onDone={() => setNeedOnboarding(false)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
