const ROOT_NAME = 'R2';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = loadConfig(env);

    if (isCorsPreflight(request)) {
      return corsPreflight();
    }

    const isUi = request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') &&
      String(request.headers.get('accept') || '').includes('text/html');
    if (isUi) {
      return new Response(UI_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const auth = checkAuth(request, url, cfg);
    if (auth !== true) {
      return new Response(auth, {
        status: 401,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'www-authenticate': 'Basic realm="R2 WebDAV", charset="UTF-8"',
        },
      });
    }

    if (cfg.readOnly && isWriteMethod(request.method)) {
      return text(403, 'This bucket is read-only.');
    }

    return handle(request, env, cfg, url);
  },
};

function loadConfig(env) {
  return {
    user: env.R2_USER || env.ADMIN_USER || '',
    pass: env.R2_PASS || env.ADMIN_PASS || '',
    publicRead: String(env.PUBLIC_READ || '').toLowerCase() === 'true',
    readOnly: String(env.READ_ONLY || '').toLowerCase() === 'true',
  };
}

function isWriteMethod(method) {
  return method === 'PUT' || method === 'DELETE' || method === 'MKCOL' || method === 'MOVE' || method === 'COPY';
}

function isCorsPreflight(request) {
  return request.method === 'OPTIONS' && request.headers.has('origin') &&
    request.headers.has('access-control-request-method');
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders('*'),
  });
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK',
    'access-control-allow-headers': 'Authorization, Content-Type, Depth, Destination, Overwrite, If, Range',
    'access-control-expose-headers': 'Content-Length, Content-Range, ETag, Location',
    'access-control-max-age': '86400',
  };
}

function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function decodeBasic(headerValue) {
  const m = String(headerValue || '').match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    const decoded = atob(m[1]);
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch (e) {
    return null;
  }
}

function checkAuth(request, url, cfg) {
  if (!cfg.user) return true;
  if (cfg.publicRead && (request.method === 'GET' || request.method === 'HEAD')) return true;

  let cred = decodeBasic(request.headers.get('Authorization'));
  if (!cred) {
    const token = url.searchParams.get('token');
    if (token) cred = decodeBasic('Basic ' + token);
  }
  if (!cred) return 'Unauthorized: missing credentials.';
  if (safeEqual(cred.user, cfg.user) && safeEqual(cred.pass, cfg.pass)) return true;
  return 'Unauthorized: invalid credentials.';
}

function text(status, body, extraHeaders) {
  return new Response(body, {
    status,
    headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, extraHeaders || {}),
  });
}

function keyFromPath(pathname) {
  let p = '';
  try {
    p = decodeURIComponent(pathname);
  } catch (e) {
    p = pathname;
  }
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

function keyToSegments(key) {
  if (!key) return [];
  return key.split('/');
}

function segmentsToKey(segments) {
  return segments.filter((s) => s.length > 0).join('/');
}

function hrefFromKey(key, isDir) {
  const segments = keyToSegments(key)
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  let href = '/' + segments.join('/');
  if (isDir) href += '/';
  if (href === '//') href = '/';
  return href;
}

async function headOrNull(bucket, key) {
  try {
    return await bucket.head(key);
  } catch (e) {
    return null;
  }
}

async function listAllKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, limit: 1000, cursor });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function isCollection(bucket, key) {
  if (key === '') return true;
  if (await headOrNull(bucket, key + '/')) return true;
  const page = await bucket.list({ prefix: key + '/', delimiter: '/', limit: 1 });
  return page.objects.length > 0 || page.delimitedPrefixes.length > 0;
}

async function listChildren(bucket, key) {
  const prefix = key === '' ? '' : key + '/';
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, delimiter: '/', limit: 1000, cursor });
    for (const o of page.objects) {
      if (o.key.endsWith('/')) continue;
      out.push({ key: o.key, dir: false, obj: o });
    }
    for (const p of page.delimitedPrefixes) {
      out.push({ key: p, dir: true, obj: null });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function handle(request, env, cfg, url) {
  const method = request.method;
  const key = keyFromPath(url.pathname);

  if (method === 'PROPFIND') return propfind(request, env, cfg, url, key);
  if (method === 'MKCOL') return mkcol(env, key);
  if (method === 'GET' || method === 'HEAD') return get(request, env, cfg, url, key, method === 'HEAD');
  if (method === 'PUT') return put(request, env, key);
  if (method === 'DELETE') return remove(env, key);
  if (method === 'MOVE' || method === 'COPY') return moveOrCopy(request, env, url, key, method === 'MOVE');
  if (method === 'OPTIONS') return davOptions();
  if (method === 'LOCK' || method === 'UNLOCK') return fakeLock();

  return text(405, 'Method Not Allowed');
}

function davOptions() {
  return new Response(null, {
    status: 200,
    headers: {
      'dav': '1, 2',
      'allow': 'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE, OPTIONS, LOCK, UNLOCK',
      'ms-author-via': 'DAV',
      'content-length': '0',
    },
  });
}

function fakeLock() {
  return new Response('<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery/><D:supportedlock/></D:prop>', {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

const escXml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function isoDate(d) {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function lastModified(d) {
  return d ? new Date(d).toUTCString() : new Date().toUTCString();
}

function buildEntry(key, isDir, obj, bucketName) {
  const name = isDir && key === '' ? '/' : decodeURIComponent(key.split('/').filter(Boolean).pop() || '');
  const href = hrefFromKey(key, isDir);
  const uploaded = obj && obj.uploaded ? new Date(obj.uploaded) : new Date();
  let props = '';
  if (isDir) {
    props += '<D:resourcetype><D:collection/></D:resourcetype>';
  } else {
    props += '<D:resourcetype/>';
    const size = obj ? Number(obj.size) : 0;
    const ct = obj && obj.httpMetadata && obj.httpMetadata.contentType ? obj.httpMetadata.contentType : 'application/octet-stream';
    const etag = obj && obj.etag ? obj.etag : '';
    props += '<D:getcontentlength>' + size + '</D:getcontentlength>';
    props += '<D:getcontenttype>' + escXml(ct) + '</D:getcontenttype>';
    if (etag) props += '<D:getetag>"' + escXml(etag) + '"</D:getetag>';
  }
  props += '<D:displayname>' + escXml(name) + '</D:displayname>';
  props += '<D:creationdate>' + isoDate(uploaded) + '</D:creationdate>';
  props += '<D:getlastmodified>' + lastModified(uploaded) + '</D:getlastmodified>';
  props += '<D:ishidden>false</D:ishidden>';
  return '<D:response><D:href>' + escXml(href) + '</D:href>' +
    '<D:propstat><D:prop>' + props + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
}

function multistatus(entries) {
  const body = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' + entries.join('') + '</D:multistatus>';
  return new Response(body, {
    status: 207,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

async function propfind(request, env, cfg, url, key) {
  const depth = request.headers.get('depth') || '1';
  if (key === '') {
    if (depth === '0') return multistatus([buildEntry('', true, null)]);
    const children = await listChildren(env.R2, '');
    const entries = [buildEntry('', true, null)];
    for (const c of children) entries.push(buildEntry(c.key, c.dir, c.obj));
    return multistatus(entries);
  }

  if (await isCollection(env.R2, key)) {
    if (depth === '0') return multistatus([buildEntry(key, true, null)]);
    const children = await listChildren(env.R2, key);
    const entries = [buildEntry(key, true, null)];
    for (const c of children) entries.push(buildEntry(c.key, c.dir, c.obj));
    return multistatus(entries);
  }

  const obj = await headOrNull(env.R2, key);
  if (!obj) return text(404, 'Not Found');
  return multistatus([buildEntry(key, false, obj)]);
}

async function mkcol(env, key) {
  if (key === '') return text(405, 'Cannot create root.');
  if (await headOrNull(env.R2, key + '/')) return text(405, 'Already exists.');
  const page = await env.R2.list({ prefix: key + '/', limit: 1 });
  if (page.objects.length > 0) return text(405, 'Already exists.');
  await env.R2.put(key + '/', new Uint8Array(0), {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  return new Response(null, { status: 201 });
}

async function put(request, env, key) {
  if (key === '') return text(400, 'Invalid path.');
  if (key.endsWith('/')) {
    if (!(await headOrNull(env.R2, key))) {
      await env.R2.put(key, new Uint8Array(0), {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    }
    return new Response(null, { status: 201 });
  }
  const ct = request.headers.get('content-type') || 'application/octet-stream';
  await env.R2.put(key, request.body, { httpMetadata: { contentType: ct } });
  return new Response(null, { status: 201 });
}

function parseRange(rangeHeader, size) {
  const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    if (end === 0) return null;
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (start >= size) return null;
    if (end === null || end >= size) end = size - 1;
    if (end < start) return null;
  }
  return { offset: start, length: end - start + 1 };
}

function buildGetHeaders(obj, url) {
  const headers = new Headers();
  const ct = obj.httpMetadata && obj.httpMetadata.contentType ? obj.httpMetadata.contentType : 'application/octet-stream';
  headers.set('content-type', ct);
  headers.set('content-length', String(obj.size));
  headers.set('etag', '"' + obj.etag + '"');
  headers.set('last-modified', lastModified(obj.uploaded));
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=0');
  if (url.searchParams.has('download')) {
    const name = decodeURIComponent(keyToSegments(keyFromPath(url.pathname)).pop() || 'download');
    headers.set('content-disposition', 'attachment; filename="' + name.replace(/["\\]/g, '_') + '"');
  }
  return headers;
}

async function get(request, env, cfg, url, key, isHead) {
  const obj = await headOrNull(env.R2, key);
  if (!obj) return text(404, 'Not Found');
  const headers = buildGetHeaders(obj, url);
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, obj.size);
    if (!parsed) return new Response(null, {
      status: 416,
      headers: { 'content-range': 'bytes */' + obj.size },
    });
    const part = await env.R2.get(key, { range: { offset: parsed.offset, length: parsed.length } });
    if (!part) return text(404, 'Not Found');
    headers.set('content-range', 'bytes ' + parsed.offset + '-' + (parsed.offset + parsed.length - 1) + '/' + obj.size);
    headers.set('content-length', String(parsed.length));
    if (isHead) return new Response(null, { status: 206, headers });
    return new Response(part.body, { status: 206, headers });
  }
  if (isHead) return new Response(null, { status: 200, headers });
  const full = await env.R2.get(key);
  if (!full) return text(404, 'Not Found');
  headers.set('content-length', String(full.size));
  return new Response(full.body, { status: 200, headers });
}

async function remove(env, key) {
  if (key === '') return text(403, 'Cannot delete root.');
  if (await isCollection(env.R2, key)) {
    const keys = await listAllKeys(env.R2, key + '/');
    if (!(await headOrNull(env.R2, key + '/'))) keys.push(key + '/');
    if (keys.length === 0) return text(404, 'Not Found');
    await Promise.all(keys.map((k) => env.R2.delete(k)));
    return new Response(null, { status: 204 });
  }
  if (!(await headOrNull(env.R2, key))) return text(404, 'Not Found');
  await env.R2.delete(key);
  return new Response(null, { status: 204 });
}

function parseDestination(request, url) {
  const dest = request.headers.get('destination');
  if (!dest) return null;
  let dstUrl;
  try {
    dstUrl = new URL(dest, url.origin);
  } catch (e) {
    return null;
  }
  return keyFromPath(dstUrl.pathname);
}

async function copyResource(env, srcKey, dstKey) {
  if (await isCollection(env.R2, srcKey)) {
    const srcPrefix = srcKey === '' ? '' : srcKey + '/';
    const dstPrefix = dstKey === '' ? '' : dstKey + '/';
    const all = await listAllKeys(env.R2, srcKey === '' ? '' : srcKey + '/');
    if (srcKey !== '' && !(await headOrNull(env.R2, srcKey + '/'))) all.push(srcKey + '/');
    for (const k of all) {
      const rel = k.slice(srcPrefix.length);
      const obj = await env.R2.get(k);
      if (!obj) continue;
      await env.R2.put(dstPrefix + rel, obj.body, { httpMetadata: obj.httpMetadata });
    }
    return;
  }
  const obj = await env.R2.get(srcKey);
  if (!obj) return 404;
  await env.R2.put(dstKey, obj.body, { httpMetadata: obj.httpMetadata });
}

async function moveOrCopy(request, env, url, srcKey, isMove) {
  const dstKey = parseDestination(request, url);
  if (dstKey === null || dstKey === '') return text(400, 'Missing Destination header.');
  if (srcKey === '') return text(403, 'Cannot move root.');
  if (dstKey === srcKey) return text(403, 'Source and destination are identical.');

  const overwrite = String(request.headers.get('overwrite') || 'T').toUpperCase() === 'T';

  const srcExists = await headOrNull(env.R2, srcKey) || await isCollection(env.R2, srcKey);
  if (!srcExists) return text(404, 'Not Found');

  if (isMove && dstKey.startsWith(srcKey + '/')) return text(409, 'Cannot move a collection into itself.');

  const dstExists = await headOrNull(env.R2, dstKey) || await isCollection(env.R2, dstKey);
  if (dstExists) {
    if (!overwrite) return text(412, 'Precondition Failed.');
    await remove(env, dstKey);
  }

  if (isMove) {
    const result = await copyResource(env, srcKey, dstKey);
    if (result === 404) return text(404, 'Not Found');
    const all = await listAllKeys(env.R2, srcKey === '' ? '' : srcKey + '/');
    if (await headOrNull(env.R2, srcKey + '/')) all.push(srcKey + '/');
    if (await headOrNull(env.R2, srcKey)) all.push(srcKey);
    await Promise.all(all.map((k) => env.R2.delete(k)));
  } else {
    const result = await copyResource(env, srcKey, dstKey);
    if (result === 404) return text(404, 'Not Found');
  }

  return new Response(null, {
    status: 201,
    headers: { location: hrefFromKey(dstKey, dstKey.endsWith('/')) },
  });
}

const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>R2 WebDAV 文件管理器</title>
<style>
:root {
  --bg: #0f172a; --panel: #1e293b; --panel2: #27364a; --border: #334155;
  --text: #e2e8f0; --muted: #94a3b8; --accent: #38bdf8; --danger: #f87171;
  --ok: #4ade80; --radius: 10px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; min-height: 100vh; }
button, input { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); background: var(--panel2); color: var(--text); padding: 7px 14px; border-radius: 8px; transition: background .15s; }
button:hover { background: #334155; }
button.primary { background: var(--accent); color: #0f172a; border-color: var(--accent); font-weight: 600; }
button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
button.danger:hover { background: rgba(248,113,113,.12); }
.hidden { display: none !important; }
.login { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login form { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; width: 100%; max-width: 360px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
.login h1 { font-size: 20px; margin-bottom: 6px; }
.login p { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
.login input { width: 100%; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); }
.login button { width: 100%; padding: 10px; }
.login .hint { margin-top: 14px; margin-bottom: 0; font-size: 12px; line-height: 1.6; }
#app { display: flex; flex-direction: column; height: 100vh; }
header { display: flex; align-items: center; gap: 10px; padding: 12px 18px; background: var(--panel); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
header .brand { font-weight: 700; font-size: 16px; margin-right: auto; display: flex; align-items: center; gap: 8px; }
header .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); }
#dropzone { flex: 1; overflow: auto; position: relative; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
th { position: sticky; top: 0; background: var(--panel); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; z-index: 2; }
td.size, td.time { color: var(--muted); white-space: nowrap; }
tr:hover td { background: rgba(56,189,248,.05); }
tr.selected td { background: rgba(56,189,248,.12); }
td.name { cursor: pointer; }
td.name .icon { display: inline-block; width: 18px; margin-right: 8px; vertical-align: middle; color: var(--accent); }
td.name .icon.file { color: var(--muted); }
td.actions { white-space: nowrap; }
td.actions button { padding: 4px 9px; font-size: 12px; margin-left: 4px; }
.breadcrumb { display: flex; align-items: center; gap: 4px; padding: 8px 18px; background: var(--panel2); border-bottom: 1px solid var(--border); font-size: 14px; flex-wrap: wrap; }
.breadcrumb .crumb { cursor: pointer; color: var(--accent); padding: 2px 4px; border-radius: 4px; }
.breadcrumb .crumb:hover { background: rgba(56,189,248,.15); }
.breadcrumb .sep { color: var(--muted); }
.breadcrumb .crumb.current { color: var(--text); cursor: default; }
#empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; color: var(--muted); }
#empty .big { font-size: 44px; margin-bottom: 12px; }
#dropzone.dragging { outline: 2px dashed var(--accent); outline-offset: -8px; background: rgba(56,189,248,.06); }
#toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 50; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast-item { background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent); padding: 10px 18px; border-radius: 8px; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.35); animation: slide .2s ease; max-width: 90vw; }
.toast-item.error { border-left-color: var(--danger); }
.toast-item.ok { border-left-color: var(--ok); }
@keyframes slide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.progress-wrap { position: fixed; inset: 0; background: rgba(2,6,23,.7); display: flex; align-items: center; justify-content: center; z-index: 60; }
.progress-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; width: min(90vw, 420px); }
.progress-card .file { font-size: 13px; color: var(--muted); margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { height: 10px; background: var(--panel2); border-radius: 6px; overflow: hidden; margin-bottom: 8px; }
.bar > div { height: 100%; background: var(--accent); width: 0%; transition: width .15s; }
.progress-card .pct { font-size: 12px; color: var(--muted); text-align: right; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }
#dropHint { display: none; }
#dropzone.dragging #dropHint { display: flex; }
footer { padding: 8px 18px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); text-align: right; }
</style>
</head>
<body>
<div id="login" class="login">
  <form id="loginForm">
    <h1>R2 文件管理器</h1>
    <p>输入访问凭据以继续</p>
    <input id="loginUser" placeholder="用户名" autocomplete="username">
    <input id="loginPass" type="password" placeholder="密码" autocomplete="current-password">
    <button class="primary" type="submit">登录</button>
    <p class="hint">凭据由部署者在 Worker 环境变量中配置（R2_USER / R2_PASS）。若未配置凭据则无需登录。</p>
  </form>
</div>

<div id="app" class="hidden">
  <header>
    <div class="brand"><span class="dot"></span>R2 WebDAV 文件管理器</div>
    <button id="newFolderBtn">新建文件夹</button>
    <button class="primary" id="uploadBtn">上传文件</button>
    <input type="file" id="fileInput" multiple hidden>
    <button id="refreshBtn">刷新</button>
    <button id="deleteSelBtn">删除选中</button>
    <button id="logoutBtn">退出登录</button>
  </header>
  <nav id="breadcrumb" class="breadcrumb"></nav>
  <div id="dropzone">
    <table>
      <thead>
        <tr>
          <th style="width:36px"><input type="checkbox" id="selectAll"></th>
          <th>名称</th>
          <th style="width:120px">大小</th>
          <th style="width:190px">修改时间</th>
          <th style="width:260px">操作</th>
        </tr>
      </thead>
      <tbody id="fileList"></tbody>
    </table>
    <div id="empty" class="hidden">
      <div class="big"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
      <div>当前目录为空，拖拽文件到此处即可上传</div>
    </div>
    <div id="dropHint"></div>
  </div>
  <footer>Cloudflare Workers + R2 &middot; WebDAV 兼容</footer>
</div>

<div id="toast"></div>

<script>
(function () {
  var token = sessionStorage.getItem('r2_token') || '';
  var authHeader = token ? { 'Authorization': 'Basic ' + token } : {};
  var currentPath = '';

  function el(id) { return document.getElementById(id); }

  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast-item ' + (type || '');
    t.textContent = msg;
    el('toast').appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(function () { t.remove(); }, 3600);
  }

  function joinPath(dir, name) {
    return dir ? dir + '/' + name : name;
  }

  function encodePath(path) {
    var parts = path.split('/');
    return parts.map(function (p) { return encodeURIComponent(p); }).join('/');
  }

  function apiPath(path) {
    return '/' + encodePath(path);
  }

  function sizeOf(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function iconFor(name, isDir) {
    if (isDir) {
      return '<span class="icon">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>';
    }
    return '<span class="icon file">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>';
  }

  function parseMultistatus(xml) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xml, 'application/xml');
    var results = { folders: [], files: [] };
    var responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (var i = 0; i < responses.length; i++) {
      var resp = responses[i];
      var hrefEl = resp.getElementsByTagNameNS('DAV:', 'href')[0];
      if (!hrefEl) continue;
      var href = hrefEl.textContent;
      var selfHref = '/' + encodePath(currentPath) + (currentPath ? '/' : '');
      if (href === '/' || href === selfHref) continue;
      var nameEl = resp.getElementsByTagNameNS('DAV:', 'displayname')[0];
      var name = nameEl ? nameEl.textContent : decodeURIComponent(href.split('/').filter(Boolean).pop());
      var isDir = resp.getElementsByTagNameNS('DAV:', 'collection').length > 0;
      var size = 0;
      var sizeEl = resp.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
      if (sizeEl) size = Number(sizeEl.textContent);
      var time = '';
      var timeEl = resp.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];
      if (timeEl) time = timeEl.textContent;
      var item = { name: name, href: href, size: size, time: time };
      if (isDir) results.folders.push(item);
      else results.files.push(item);
    }
    return results;
  }

  function http(method, path, headers, body) {
    var opts = { method: method, headers: Object.assign({}, authHeader, headers || {}) };
    if (body !== undefined) opts.body = body;
    return fetch(apiPath(path), opts).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error('认证失败'); }
      return res;
    });
  }

  function renderBreadcrumb() {
    var nav = el('breadcrumb');
    nav.innerHTML = '';
    var parts = currentPath ? currentPath.split('/') : [];
    var acc = '';
    var root = document.createElement('span');
    root.className = 'crumb' + (parts.length === 0 ? ' current' : '');
    root.textContent = '根目录';
    root.onclick = function () { currentPath = ''; load(); };
    nav.appendChild(root);
    parts.forEach(function (p, i) {
      var sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' / ';
      nav.appendChild(sep);
      acc = acc ? acc + '/' + p : p;
      var c = document.createElement('span');
      c.className = 'crumb' + (i === parts.length - 1 ? ' current' : '');
      c.textContent = p;
      c.onclick = function () { currentPath = acc; load(); };
      nav.appendChild(c);
    });
  }

  function render(results) {
    var tbody = el('fileList');
    tbody.innerHTML = '';
    var rows = [];
    results.folders.forEach(function (f) {
      rows.push({ item: f, isDir: true });
    });
    results.files.forEach(function (f) {
      rows.push({ item: f, isDir: false });
    });
    rows.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.item.name.localeCompare(b.item.name, 'zh-Hans-CN');
    });

    el('empty').classList.toggle('hidden', rows.length > 0);
    el('selectAll').checked = false;

    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      var item = row.item;
      var full = currentPath ? currentPath + '/' + item.name : item.name;

      var tdCk = document.createElement('td');
      var ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.dataset.path = full;
      ck.addEventListener('change', function () {
        tr.classList.toggle('selected', ck.checked);
        updateDeleteBtn();
      });
      tdCk.appendChild(ck);

      var tdName = document.createElement('td');
      tdName.className = 'name';
      tdName.innerHTML = iconFor(item.name, row.isDir) + '<span></span>';
      tdName.lastElementChild.textContent = item.name;
      if (row.isDir) {
        tdName.title = '打开文件夹';
        tdName.onclick = function () { currentPath = full; load(); };
      } else {
        tdName.title = '下载';
        tdName.onclick = function () { downloadFile(full, item.name); };
      }

      var tdSize = document.createElement('td');
      tdSize.className = 'size';
      tdSize.textContent = row.isDir ? '-' : sizeOf(item.size);

      var tdTime = document.createElement('td');
      tdTime.className = 'time';
      tdTime.textContent = item.time;

      var tdAct = document.createElement('td');
      tdAct.className = 'actions';

      if (!row.isDir) {
        var dl = document.createElement('button');
        dl.textContent = '下载';
        dl.onclick = function () { downloadFile(full, item.name); };
        tdAct.appendChild(dl);
      }

      var rn = document.createElement('button');
      rn.textContent = '重命名';
      rn.onclick = function () { renameItem(full, row.isDir); };
      tdAct.appendChild(rn);

      var cp = document.createElement('button');
      cp.textContent = '复制路径';
      cp.onclick = function () { copyPath(full); };
      tdAct.appendChild(cp);

      var del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除';
      del.onclick = function () { deleteItems([full], row.isDir); };
      tdAct.appendChild(del);

      tr.appendChild(tdCk);
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdTime);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
    updateDeleteBtn();
  }

  function updateDeleteBtn() {
    var checked = document.querySelectorAll('#fileList input[type=checkbox]:checked');
    el('deleteSelBtn').classList.toggle('hidden', checked.length === 0);
  }

  function load() {
    renderBreadcrumb();
    var tbody = el('fileList');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">' +
      '<span class="spinner"></span>加载中...</td></tr>';
    http('PROPFIND', currentPath, { Depth: '1' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(parseMultistatus)
      .then(render)
      .catch(function (e) { toast(e.message || '加载失败', 'error'); render({ folders: [], files: [] }); });
  }

  function downloadFile(full, name) {
    var query = token ? '?token=' + encodeURIComponent(token) : '';
    var a = document.createElement('a');
    a.href = apiPath(full) + query;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function copyPath(full) {
    var text = apiPath(full);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制路径: ' + text, 'ok'); });
    } else {
      toast('路径: ' + text, 'ok');
    }
  }

  function renameItem(full, isDir) {
    var name = full.split('/').pop();
    var parent = full.slice(0, full.length - name.length).replace(/\/$/, '');
    var next = prompt('重命名 ' + name + ' 为:', name);
    if (!next || next === name) return;
    var dest = joinPath(parent, next);
    var destHref = location.origin + apiPath(dest) + (isDir ? '/' : '');
    http('MOVE', full, { Destination: destHref, Overwrite: 'F' })
      .then(function (res) {
        if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('重命名失败 HTTP ' + res.status);
        toast('已重命名', 'ok');
        load();
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function newFolder() {
    var name = prompt('输入新文件夹名称:');
    if (!name) return;
    if (name.includes('/')) { toast('名称不能包含 /', 'error'); return; }
    http('MKCOL', joinPath(currentPath, name))
      .then(function (res) {
        if (!res.ok && res.status !== 201) throw new Error('创建失败 HTTP ' + res.status);
        toast('已创建文件夹', 'ok');
        load();
      })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function deleteItems(paths, isDir) {
    if (!paths.length) return;
    var label = paths.length === 1 ? (isDir ? '文件夹' : '文件') + ' ' + paths[0] : paths.length + ' 个项目';
    if (!confirm('确定删除' + label + ' 吗？此操作不可恢复。')) return;
    var tasks = paths.map(function (p) {
      return http('DELETE', p).then(function (res) {
        if (!res.ok && res.status !== 204) throw new Error('删除 ' + p + ' 失败 HTTP ' + res.status);
      });
    });
    Promise.all(tasks)
      .then(function () { toast('删除完成', 'ok'); load(); })
      .catch(function (e) { toast(e.message, 'error'); load(); });
  }

  function uploadFiles(files) {
    if (!files.length) return;
    var overlay = document.createElement('div');
    overlay.className = 'progress-wrap';
    overlay.innerHTML = '<div class="progress-card"><div class="file"></div>' +
      '<div class="bar"><div></div></div><div class="pct">0%</div></div>';
    document.body.appendChild(overlay);
    var fileLabel = overlay.querySelector('.file');
    var bar = overlay.querySelector('.bar > div');
    var pct = overlay.querySelector('.pct');
    var idx = 0;

    function next() {
      if (idx >= files.length) {
        setTimeout(function () { overlay.remove(); }, 300);
        toast('上传完成', 'ok');
        load();
        return;
      }
      var f = files[idx];
      var dest = joinPath(currentPath, f.name);
      var xhr = new XMLHttpRequest();
      fileLabel.textContent = (idx + 1) + '/' + files.length + '  ' + f.name;
      xhr.open('PUT', apiPath(dest));
      if (token) xhr.setRequestHeader('Authorization', 'Basic ' + token);
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          var p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + '%';
          pct.textContent = p + '%';
        }
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          idx++;
          bar.style.width = '0%';
          pct.textContent = '0%';
          next();
        } else {
          overlay.remove();
          toast('上传失败 ' + f.name + ' HTTP ' + xhr.status, 'error');
        }
      };
      xhr.onerror = function () {
        overlay.remove();
        toast('上传失败 ' + f.name, 'error');
      };
      xhr.send(f);
    }
    next();
  }

  function showLogin() {
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
  }

  function enterApp() {
    el('login').classList.add('hidden');
    el('app').classList.remove('hidden');
    load();
  }

  el('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = el('loginUser').value.trim();
    var p = el('loginPass').value;
    token = btoa(unescape(encodeURIComponent(u + ':' + p)));
    authHeader = { 'Authorization': 'Basic ' + token };
    sessionStorage.setItem('r2_token', token);
    http('PROPFIND', '', { Depth: '1' })
      .then(function (res) {
        if (!res.ok) throw new Error('凭据无效');
        enterApp();
        return res.text();
      })
      .then(parseMultistatus)
      .then(render)
      .catch(function (err) {
        sessionStorage.removeItem('r2_token');
        token = '';
        authHeader = {};
        toast('登录失败：' + err.message, 'error');
      });
  });

  el('logoutBtn').addEventListener('click', function () {
    sessionStorage.removeItem('r2_token');
    token = '';
    authHeader = {};
    showLogin();
  });

  el('uploadBtn').addEventListener('click', function () { el('fileInput').click(); });
  el('fileInput').addEventListener('change', function () {
    uploadFiles(Array.prototype.slice.call(this.files));
    this.value = '';
  });
  el('newFolderBtn').addEventListener('click', newFolder);
  el('refreshBtn').addEventListener('click', load);
  el('selectAll').addEventListener('change', function () {
    var cks = document.querySelectorAll('#fileList input[type=checkbox]');
    cks.forEach(function (c) { c.checked = el('selectAll').checked; c.closest('tr').classList.toggle('selected', el('selectAll').checked); });
    updateDeleteBtn();
  });
  el('deleteSelBtn').addEventListener('click', function () {
    var cks = document.querySelectorAll('#fileList input[type=checkbox]:checked');
    var paths = Array.prototype.map.call(cks, function (c) { return c.dataset.path; });
    deleteItems(paths, false);
  });

  var dz = el('dropzone');
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('dragging'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('dragging'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault();
    dz.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(Array.prototype.slice.call(e.dataTransfer.files));
  });

  http('PROPFIND', '', { Depth: '1' })
    .then(function (res) {
      if (!res.ok) throw new Error('unauthorized');
      enterApp();
      return res.text();
    })
    .then(parseMultistatus)
    .then(render)
    .catch(function () { showLogin(); });
})();
</script>
</body>
</html>
`;
