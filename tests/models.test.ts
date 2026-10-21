// 模型下载测试（需要网络，默认跳过：设 RUN_NET_TESTS=1 才跑）
// 验证 downloadAllModels 能把 226MB 的 SenseVoice 模型完整下载下来并可读回。
import { beforeAll, describe, expect, it } from 'vitest';

// ---- Node 里没有 Cache Storage：垫一个最小实现 ----
class FakeCache {
  private store = new Map<string, Response>();
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((u) => new Request(u));
  }
  async match(req: Request | string): Promise<Response | undefined> {
    const url = typeof req === 'string' ? req : req.url;
    const r = this.store.get(url);
    return r ? r.clone() : undefined;
  }
  async put(req: Request | string, res: Response): Promise<void> {
    const url = typeof req === 'string' ? req : req.url;
    this.store.set(url, res.clone());
  }
}
const fakeCaches = {
  store: new Map<string, FakeCache>(),
  async open(name: string) {
    if (!this.store.has(name)) this.store.set(name, new FakeCache());
    return this.store.get(name)!;
  },
  async delete(name: string) {
    this.store.delete(name);
  },
};
beforeAll(() => {
  (globalThis as any).caches = fakeCaches;
});

const { downloadAllModels, hasModels, readModelFile, clearModels } = await import('../src/core/models');
const { DEFAULT_MODEL_FILES } = await import('../src/core/settings');

describe.skipIf(!process.env.RUN_NET_TESTS)('模型下载（联网）', () => {
  it('downloadAllModels 能下载完整模型并校验大小', async () => {
    await clearModels();

    await downloadAllModels(DEFAULT_MODEL_FILES, (p) => {
      if (p.loaded % (20 * 1024 * 1024) < 64 * 1024) {
        console.log(`[test] ${p.key}: ${(p.loaded / 1024 / 1024).toFixed(1)}MB / ${(p.total / 1024 / 1024).toFixed(1)}MB`);
      }
    });

    expect(await hasModels()).toBe(true);

    const modelBuf = await readModelFile('model');
    expect(modelBuf).not.toBeNull();
    expect(modelBuf!.byteLength).toBeGreaterThan(200 * 1024 * 1024); // >200MB
    console.log(`[test] model.int8.onnx 实际大小：${(modelBuf!.byteLength / 1024 / 1024).toFixed(1)}MB`);

    const tokensBuf = await readModelFile('tokens');
    expect(tokensBuf!.byteLength).toBeGreaterThan(100 * 1024);

    const vadBuf = await readModelFile('vad');
    expect(vadBuf!.byteLength).toBeGreaterThan(500 * 1024);
    console.log(`[test] silero_vad.onnx 实际大小：${(vadBuf!.byteLength / 1024).toFixed(1)}KB`);
  }, 600_000);
});
