import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worker = await import('../src/index.js');

const BASE = Number(process.env.TEST_PORT || 9877);
const BASE_URL = 'http://localhost:' + BASE;

const store = new Map();

function makeObj(key) {
  const rec = store.get(key);
  return {
    key,
    size: rec.data.length,
    etag: rec.etag,
    uploaded: rec.uploaded,
    httpMetadata: rec.httpMetadata,
  };
}

function head(key) {
  return store.has(key) ? makeObj(key) : null;
}

async function readBody(body) {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
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

function makeEtag(data) {
  let h = 0;
  for (let i = 0; i < data.length; i++) {
    h = (h * 31 + data[i]) >>> 0;
  }
  return h.toString(16) + data.length.toString(16);
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

  async head(key) {
    return head(key);
  },

  async get(key, { range } = {}) {
    const rec = store.get(key);
    if (!rec) return null;
    const data = range ? rec.data.slice(range.offset, range.offset + range.length) : rec.data;
    return {
      key,
      body: data,
      size: data.length,
      etag: rec.etag,
      uploaded: rec.uploaded,
      httpMetadata: rec.httpMetadata,
    };
  },

  async put(key, body, opts = {}) {
    const data = await readBody(body);
    const rec = {
      data,
      httpMetadata: opts.httpMetadata || {},
      etag: makeEtag(data),
      uploaded: new Date(),
    };
    store.set(key, rec);
    return rec;
  },

  async delete(key) {
    store.delete(key);
  },
};

const env = {
  R2: mockBucket,
  R2_USER: 'admin',
  R2_PASS: 'secret123',
  PUBLIC_READ: 'false',
  READ_ONLY: 'false',
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, BASE_URL);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
    const request = new Request(url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
    });
    try {
      const resp = await worker.default.fetch(request, env, {});
      res.writeHead(resp.status, Object.fromEntries(resp.headers));
      const respBody = await resp.arrayBuffer();
      res.end(Buffer.from(respBody));
    } catch (err) {
      console.error('SERVER ERROR for', req.method, req.url, err);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
});

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}

function basic() {
  return { Authorization: 'Basic ' + Buffer.from('admin:secret123').toString('base64') };
}

async function rawFetch(method, path, opts = {}) {
  const resp = await fetch(BASE_URL + path, {
    method,
    headers: Object.assign({}, basic(), opts.headers || {}),
    body: opts.body,
  });
  return resp;
}

await new Promise((r) => server.listen(BASE, r));

try {
  console.log('\n[1] 认证');
  {
    const r = await fetch(BASE_URL + '/hello.txt', { method: 'PUT', body: 'x' });
    assert(r.status === 401, '无凭据 PUT 返回 401');
    assert(r.headers.get('www-authenticate') && r.headers.get('www-authenticate').includes('Basic'), '返回 WWW-Authenticate');
  }

  console.log('\n[2] 上传与列表');
  {
    const r = await rawFetch('PUT', '/hello.txt', { body: 'Hello R2 World', headers: { 'content-type': 'application/octet-stream' } });
    assert(r.status === 201, '上传 hello.txt 返回 201');

    const r2 = await rawFetch('PUT', '/docs/readme.md', { body: '# Docs', headers: { 'content-type': 'text/markdown' } });
    assert(r2.status === 201, '上传 docs/readme.md 返回 201');

    const pf = await rawFetch('PROPFIND', '/', { headers: { Depth: '1' } });
    assert(pf.status === 207, '根目录 PROPFIND 返回 207');
    const xml = await pf.text();
    assert(xml.includes('hello.txt'), '列表包含 hello.txt');
    assert(xml.includes('docs/'), '列表包含 docs 目录');
    assert(xml.includes('multistatus'), '响应为 multistatus');
  }

  console.log('\n[3] MKCOL 目录创建');
  {
    const r = await rawFetch('MKCOL', '/photos');
    assert(r.status === 201, 'MKCOL /photos 返回 201');
    const r2 = await rawFetch('MKCOL', '/photos');
    assert(r2.status === 405, '重复 MKCOL 返回 405');
  }

  console.log('\n[4] 目录内操作');
  {
    const r = await rawFetch('PUT', '/photos/beach.jpg', { body: 'jpegdata' });
    assert(r.status === 201, '上传 photos/beach.jpg 返回 201');
    const pf = await rawFetch('PROPFIND', '/photos', { headers: { Depth: '1' } });
    const xml = await pf.text();
    assert(xml.includes('beach.jpg'), 'photos 列表包含 beach.jpg');
    assert(xml.includes('getcontentlength'), '包含文件大小属性');
  }

  console.log('\n[5] GET / 下载与 Range');
  {
    const r = await rawFetch('GET', '/hello.txt');
    assert(r.status === 200, 'GET hello.txt 返回 200');
    assert((await r.text()) === 'Hello R2 World', '内容正确');
    assert(r.headers.get('content-type') === 'application/octet-stream', '默认 content-type');

    const r2 = await rawFetch('GET', '/hello.txt', { headers: { Range: 'bytes=0-4' } });
    assert(r2.status === 206, 'Range 请求返回 206');
    assert((await r2.text()) === 'Hello', 'Range 内容正确');
    assert(r2.headers.get('content-range') === 'bytes 0-4/14', 'Content-Range 正确');

    const r3 = await rawFetch('GET', '/docs/readme.md');
    assert(r3.headers.get('content-type') === 'text/markdown', '保留上传 content-type');
  }

  console.log('\n[6] 404');
  {
    const r = await rawFetch('GET', '/not-exist.txt');
    assert(r.status === 404, '不存在的文件返回 404');
  }

  console.log('\n[7] COPY');
  {
    const r = await rawFetch('COPY', '/hello.txt', { headers: { Destination: BASE_URL + '/copy.txt' } });
    assert(r.status === 201, 'COPY 返回 201');
    const g = await rawFetch('GET', '/copy.txt');
    assert((await g.text()) === 'Hello R2 World', '副本内容正确');
    const g2 = await rawFetch('GET', '/hello.txt');
    assert(g2.status === 200, '源文件仍存在');
  }

  console.log('\n[8] MOVE / 重命名');
  {
    const r = await rawFetch('MOVE', '/copy.txt', { headers: { Destination: BASE_URL + '/renamed.txt' } });
    assert(r.status === 201, 'MOVE 返回 201');
    const g = await rawFetch('GET', '/renamed.txt');
    assert(g.status === 200, '新路径可访问');
    const g2 = await rawFetch('GET', '/copy.txt');
    assert(g2.status === 404, '旧路径已删除');
  }

  console.log('\n[9] 目录 MOVE（递归）');
  {
    const r = await rawFetch('PUT', '/docs/guide.md', { body: 'guide' });
    assert(r.status === 201, '准备 docs/guide.md');
    const mv = await rawFetch('MOVE', '/docs', { headers: { Destination: BASE_URL + '/manual' } });
    assert(mv.status === 201, '目录 MOVE 返回 201');
    const a = await rawFetch('GET', '/manual/readme.md');
    const b = await rawFetch('GET', '/manual/guide.md');
    assert(a.status === 200 && b.status === 200, '子文件已迁移');
    const old = await rawFetch('GET', '/docs/readme.md');
    assert(old.status === 404, '原目录已删除');
  }

  console.log('\n[10] 删除');
  {
    const r = await rawFetch('DELETE', '/hello.txt');
    assert(r.status === 204, '删除文件返回 204');
    const g = await rawFetch('GET', '/hello.txt');
    assert(g.status === 404, '删除后 404');

    const pf = await rawFetch('PROPFIND', '/photos', { headers: { Depth: '1' } });
    const xml = await pf.text();
    assert(xml.includes('beach.jpg'), '删除前 photos 有文件');
    const d = await rawFetch('DELETE', '/photos');
    assert(d.status === 204, '删除目录返回 204');
    const pf2 = await rawFetch('PROPFIND', '/', { headers: { Depth: '1' } });
    const xml2 = await pf2.text();
    assert(!xml2.includes('photos'), '根列表不再包含 photos');
  }

  console.log('\n[11] OPTIONS 与 DAV 能力');
  {
    const r = await rawFetch('OPTIONS', '/');
    assert(r.status === 200, 'OPTIONS 返回 200');
    assert(r.headers.get('dav') === '1, 2', 'DAV 头正确');
  }

  console.log('\n[12] Web UI');
  {
    const r = await fetch(BASE_URL + '/', { headers: { accept: 'text/html' } });
    assert(r.status === 200, 'UI 页面返回 200');
    assert((r.headers.get('content-type') || '').includes('text/html'), 'UI 为 HTML');
    const html = await r.text();
    assert(html.includes('R2 WebDAV'), 'UI 包含标题');
  }

  console.log('\n[13] READ_ONLY 模式');
  {
    const envRo = Object.assign({}, env, { READ_ONLY: 'true' });
    const roServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const url = new URL(req.url, 'http://localhost:8788');
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
        const request = new Request(url, {
          method: req.method, headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const resp = await worker.default.fetch(request, envRo, {});
        res.writeHead(resp.status, Object.fromEntries(resp.headers));
        res.end(Buffer.from(await resp.arrayBuffer()));
      });
    });
    await new Promise((r) => roServer.listen(8788, r));
    const r = await fetch('http://localhost:8788/w.txt', {
      method: 'PUT', body: 'x',
      headers: basic(),
    });
    assert(r.status === 403, '只读模式下 PUT 返回 403');
    roServer.close();
  }

  console.log('\n[14] PUBLIC_READ 模式');
  {
    const envPub = Object.assign({}, env, { PUBLIC_READ: 'true' });
    const pubServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const url = new URL(req.url, 'http://localhost:8789');
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
        const request = new Request(url, {
          method: req.method, headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const resp = await worker.default.fetch(request, envPub, {});
        res.writeHead(resp.status, Object.fromEntries(resp.headers));
        res.end(Buffer.from(await resp.arrayBuffer()));
      });
    });
    await new Promise((r) => pubServer.listen(8789, r));
    const g = await fetch('http://localhost:8789/manual/readme.md');
    assert(g.status === 200, '公读模式无需凭据 GET');
    const w = await fetch('http://localhost:8789/nope.txt', {
      method: 'PUT', body: 'x',
    });
    assert(w.status === 401, '公读模式写入仍需凭据');
    pubServer.close();
  }

  console.log('\n[15] token 查询参数认证');
  {
    const token = Buffer.from('admin:secret123').toString('base64');
    const r = await fetch(BASE_URL + '/manual/readme.md?token=' + token);
    assert(r.status === 200, 'token 参数可下载');
  }
} catch (e) {
  console.error('测试异常:', e);
  failed++;
} finally {
  server.close();
}

console.log('\n==================================');
console.log('通过: ' + passed + '   失败: ' + failed);
process.exit(failed ? 1 : 0);
