import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worker = await import('../src/index.js');

const PORT = Number(process.env.PREVIEW_PORT || 8000);
const BASE_URL = 'http://localhost:' + PORT;

const store = new Map();

function makeEtag(data) {
  let h = 0;
  for (let i = 0; i < data.length; i++) h = (h * 31 + data[i]) >>> 0;
  return h.toString(16) + data.length.toString(16);
}

async function readBody(body) {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  const chunks = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const len = chunks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function makeObj(key) {
  const rec = store.get(key);
  return { key, size: rec.data.length, etag: rec.etag, uploaded: rec.uploaded, httpMetadata: rec.httpMetadata };
}

const mockBucket = {
  async list({ prefix = '', delimiter = null, limit = Infinity, cursor = '' } = {}) {
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    let startIdx = cursor ? Number(cursor) : 0;
    const entries = [];
    const seen = new Set();
    for (let i = startIdx; i < keys.length; i++) {
      const k = keys[i];
      const rem = k.slice(prefix.length);
      if (delimiter && rem.includes(delimiter)) {
        const cp = prefix + rem.slice(0, rem.indexOf(delimiter)) + delimiter;
        if (!seen.has(cp)) { seen.add(cp); entries.push({ kind: 'prefix', key: cp }); }
      } else {
        entries.push({ kind: 'object', key: k });
      }
    }
    const objects = [];
    const delimitedPrefixes = [];
    let truncated = false;
    let cursorOut = null;
    for (let i = 0; i < entries.length; i++) {
      if (i >= limit) { truncated = true; cursorOut = String(startIdx + i); break; }
      const e = entries[i];
      if (e.kind === 'object') objects.push(makeObj(e.key));
      else delimitedPrefixes.push(e.key);
    }
    return { objects, delimitedPrefixes, truncated, cursor: cursorOut };
  },
  async head(key) { return store.has(key) ? makeObj(key) : null; },
  async get(key) {
    const rec = store.get(key);
    if (!rec) return null;
    return { key, body: rec.data, size: rec.data.length, etag: rec.etag, uploaded: rec.uploaded, httpMetadata: rec.httpMetadata };
  },
  async put(key, body, opts = {}) {
    const data = await readBody(body);
    store.set(key, { data, httpMetadata: opts.httpMetadata || {}, etag: makeEtag(data), uploaded: new Date() });
  },
  async delete(key) { store.delete(key); },
};

const seed = {
  'hello.txt': 'Hello R2 World - 毛玻璃文件管理器',
  'readme.md': '# R2 WebDAV 文件管理器\n\n基于 Cloudflare Workers + R2 的轻量网盘。\n',
  'photos/sunset.jpg': 'demo jpeg bytes',
  'photos/mountain.png': 'demo png bytes',
  'docs/guide.txt': '使用说明：拖拽文件到页面即可上传。',
  'video/demo.mp4': 'demo mp4 bytes',
};

for (const [k, v] of Object.entries(seed)) {
  const data = new TextEncoder().encode(v);
  store.set(k, { data, httpMetadata: {}, etag: makeEtag(data), uploaded: new Date() });
}

const env = { R2: mockBucket, R2_USER: '', R2_PASS: '', PUBLIC_READ: 'false', READ_ONLY: 'false' };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, BASE_URL);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
    const request = new Request(url, { method: req.method, headers, body: body.length ? body : undefined });
    try {
      const resp = await worker.default.fetch(request, env, {});
      res.writeHead(resp.status, Object.fromEntries(resp.headers));
      res.end(Buffer.from(await resp.arrayBuffer()));
    } catch (err) {
      console.error('SERVER ERROR for', req.method, req.url, err);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
});

server.listen(PORT, () => {
  console.log('R2 WebDAV preview server running at ' + BASE_URL);
});
