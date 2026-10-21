// 设置（chrome.storage.local）—— 模型下载地址是配置项，用户可换成自己的国内 CDN
export interface ModelFiles {
  /** SenseVoice int8 主模型（2024-07-17 版） */
  modelUrl: string;
  /** tokens.txt */
  tokensUrl: string;
  /** Silero VAD */
  vadUrl: string;
  /** 可选 SHA-256 校验（空串跳过校验） */
  modelSha256: string;
  /**
   * 备用下载地址（主地址不通时自动换用）——**按文件分别配**。
   * 之前踩过的坑：三份文件共用一份兜底列表，结果主地址失败时把 VAD 当成模型存了进去。
   */
  modelFallbackUrls?: Partial<Record<'model' | 'tokens' | 'vad', string[]>>;
}

export interface Settings {
  lineMode: 'sentence' | 'clause';
  maxLineChars: number;
  pauseBreakMs: number;
  /** 每行最长时长（秒） */
  maxLineSec: number;
  asrEngine: 'browser';
  maxDurationMin: number;
  audioKeepDays: number;
  llmBaseUrl: string;
  llmKey: string;
  llmModel: string;
  removeFillers: boolean;
  copyFormat: 'text' | 'text_ts';
  /** 复制时是否在开头附上来源信息（标题/作者/链接） */
  copyWithSource: boolean;
  /** 易错词表：每行「错字=正字」，转写后自动替换（纠正同音字错误） */
  lexicon: string;
  /** 模型下载地址（配置项：换成自己的 CDN 只改这里） */
  model: ModelFiles;
  /** 首次引导是否完成（模型下载完） */
  onboarded: boolean;
}

export const DEFAULT_MODEL_FILES: ModelFiles = {
  // 开发默认值：hf-mirror（国内可直连）+ GitHub releases。分发前请换成自己的 CDN，只改这三项。
  // SenseVoice int8（2024-07-17 版）model.int8.onnx + tokens.txt（配套文件，务必同源同版本）
  // 规格明确要求用 2024-07-17 版：2025-09-09 版是用粤语数据微调的，输出不带标点。
  modelUrl:
    'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
  tokensUrl:
    'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
  // Silero VAD（k2-fsa 导出，仅 16 kHz，约 629KB）；
  // 主地址走 GitHub（实测国内经常超时），备用走 hf-mirror
  vadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  modelSha256: '',
  // 主地址不通时的备用地址（**按文件分别配**，下载时会校验文件大小，拿到不对的文件会被拒）
  modelFallbackUrls: {
    model: [
      // 国内可用性优先：modelscope（国内 CDN）→ gh-proxy → huggingface.co 直连 → hf-mirror
      'https://www.modelscope.cn/models/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/master/model.int8.onnx',
      'https://gh-proxy.com/https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx?download=true',
    ],
    tokens: [
      'https://gh-proxy.com/https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
      'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
      'https://www.modelscope.cn/models/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/master/tokens.txt',
    ],
    vad: [
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-vad/resolve/main/silero_vad.onnx',
      'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      'https://huggingface.co/csukuangfj/sherpa-onnx-vad/resolve/main/silero_vad.onnx',
    ],
  },
};

export const DEFAULT_SETTINGS: Settings = {
  lineMode: 'sentence',
  maxLineChars: 60,
  pauseBreakMs: 1200,
  maxLineSec: 20,
  asrEngine: 'browser',
  maxDurationMin: 30,
  audioKeepDays: 30,
  llmBaseUrl: '',
  llmKey: '',
  llmModel: '',
  removeFillers: false,
  copyFormat: 'text',
  copyWithSource: false,
  lexicon: '',
  model: DEFAULT_MODEL_FILES,
  onboarded: false,
};

const KEY = 'settings-v2';
const LEGACY_KEY = 'settings';

/**
 * 迁移说明：成行规则从「按语音段切」改成「按标点成行」后，相关默认值的含义变了
 * （每行字数 32→60、新增每行最长时长）。
 * 旧存储里的这些字段多半是老版本的默认值，继续沿用会让新规则失效，
 * 所以：这些字段只认新存储里用户改过的值，否则一律用新默认。
 * 模型地址等用户可能自定义的字段照旧沿用。
 */
const RESET_ON_MIGRATE = ['maxLineChars', 'maxLineSec', 'lineMode', 'copyFormat', 'copyWithSource', 'maxDurationMin'] as const;

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get([KEY, LEGACY_KEY]);
  const legacy = (got[LEGACY_KEY] ?? {}) as Partial<Settings>;
  const cur = (got[KEY] ?? {}) as Partial<Settings>;
  const base: Partial<Settings> = { ...legacy, ...cur };
  const storedModel = (base.model ?? {}) as Partial<ModelFiles>;
  // 老版本存的兜底地址是一个「所有文件共用」的数组（里面全是 VAD 的地址），
  // 结果主模型地址失败时把 VAD 当成模型存了进去。这种格式直接作废，用新的按文件列表。
  const legacyFallback = Array.isArray(storedModel.modelFallbackUrls);
  const out: Settings = {
    ...DEFAULT_SETTINGS,
    ...base,
    model: {
      ...DEFAULT_MODEL_FILES,
      ...storedModel,
      ...(legacyFallback
        ? { modelFallbackUrls: DEFAULT_MODEL_FILES.modelFallbackUrls }
        : {}),
    },
  };
  for (const k of RESET_ON_MIGRATE) {
    if (!(k in cur)) (out as any)[k] = (DEFAULT_SETTINGS as any)[k];
  }
  return out;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = { ...cur, ...patch, model: { ...cur.model, ...(patch.model ?? {}) } };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}



