// 本地模型服务器：给扩展提供模型文件（网络不通时也能测）
// 用法：node scripts/local-model-server.mjs [端口]
// 环境变量：
//   LIMIT_1MB=1   模拟「一次只给 1MB」的 CDN
//   BAD_MODEL=1   模拟「model 路径返回了 VAD 文件」（主地址失败后兜底给错文件的场景）
//   STALL_MODEL=1 模拟「model 路径连上但一直不发数据」（大文件下载卡死）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'node_modules', '.smoke');
const port = Number(process.argv[2] ?? 8788);
const LIMIT_1MB = process.env.LIMIT_1MB === '1';
const BAD_MODEL = process.env.BAD_MODEL === '1';
const STALL_MODEL = process.env.STALL_MODEL === '1';
let stallCount = 0;

http.createServer((req, res) => {
  let name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '');
  // 模拟：model 路径连上后一直不发数据（大文件下载卡死）
  // 只卡第一次请求：这样「主地址卡死 → 换备用地址 → 成功」这条链路能被完整测到
  if (STALL_MODEL && name === 'model.int8.onnx' && stallCount++ < 1) {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' });
    return;   // 故意不结束也不写数据
  }
  // 模拟：model 路径返回 VAD 文件
  if (BAD_MODEL && name === 'model.int8.onnx') name = 'silero_vad.onnx';
  const file = path.join(dir, name);
  if (!file.startsWith(dir) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
    return;
  }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
  };
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    // 模拟部分 CDN：一次最多只给 1MB（用户遇到的"下载只有 1MB"就是这种服务器）
    if (LIMIT_1MB) {
      const MAX_CHUNK = 1024 * 1024;
      if (end - start + 1 > MAX_CHUNK) end = start + MAX_CHUNK - 1;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    if (LIMIT_1MB) {
      // 不带 Range 的请求：也只给 1MB（同样模拟服务器限量）
      const MAX_CHUNK = 1024 * 1024;
      const end = Math.min(size, MAX_CHUNK) - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes 0-${end}/${size}`, 'Content-Length': end + 1 });
      fs.createReadStream(file, { start: 0, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
  }
}).listen(port, '127.0.0.1', () => console.log(`本地模型服务器： http://127.0.0.1:${port}/`));
