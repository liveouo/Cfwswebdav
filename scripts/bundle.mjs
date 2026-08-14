import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const source = readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

const banner = [
  '/**',
  ' * R2 WebDAV Worker - 单文件构建',
  ' * 由 scripts/bundle.mjs 从 src/index.js 生成',
  ' * 可直接粘贴到 Cloudflare Dashboard Workers 编辑器中使用',
  ' * 部署说明见 DEPLOY.md',
  ' */',
  '',
].join('\n');

mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = banner + source;
writeFileSync(path.join(root, 'dist', 'worker.js'), out);
console.log('已生成 dist/worker.js (' + Buffer.byteLength(out) + ' bytes)');
