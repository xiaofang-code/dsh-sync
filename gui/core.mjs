/**
 * dsh-sync 核心库 —— 不依赖任何 UI，CLI 和图形界面共用。
 *
 * 关键约束（DSH 内部规则，别改）：
 *   sessions/<projectKey(header.cwd)>/<encodeSegment(header.id)>/session.v4.jsonl.zstd
 *   目录名必须能由 header 里的 cwd + id 反算出来，否则 DSH 报 corrupt session log。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const MANIFEST_NAME = 'manifest.json';
export const TOOL_VERSION = 1;
export const LOG_NAME_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/u;

// ───────────────────────────── 基础工具 ─────────────────────────────

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function defaultDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

/** DSH 的 projectKey：cwd → 目录名 */
export function projectKey(cwd) {
  if (!cwd) throw new Error('cwd 为空');
  let readable = '';
  let sep = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sep) readable += '-';
      sep = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      sep = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      sep = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** DSH 的 session 目录名编码 */
export function encodeSegment(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

// ───────────────────────────── zstd 帧处理 ─────────────────────────────

/** 按 magic 切分 zstd 帧 */
export function splitFrames(buf) {
  const frames = [];
  let off = 0;
  while (off < buf.length) {
    const next = buf.indexOf(ZSTD_MAGIC, off + 4);
    const end = next < 0 ? buf.length : next;
    frames.push(buf.subarray(off, end));
    if (next < 0) break;
    off = next;
  }
  return frames;
}

/** 用 DSH 同款参数压缩（带 checksum） */
export function zstdCompress(buf) {
  return zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
}

/** 读会话 header（第一帧） */
export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, chunk, 0, chunk.length, 0);
    const frames = splitFrames(chunk.subarray(0, n));
    if (frames.length === 0) throw new Error('空文件');
    return JSON.parse(zlib.zstdDecompressSync(frames[0]).toString('utf8').trim());
  } finally {
    fs.closeSync(fd);
  }
}

/** 改写 header.cwd，其余帧原样保留 */
export function rewriteHeaderCwd(buf, newCwd) {
  const frames = splitFrames(buf);
  if (frames.length === 0) throw new Error('空文件');
  const header = JSON.parse(zlib.zstdDecompressSync(frames[0]).toString('utf8').trim());
  if (header.cwd === newCwd) return { buf, header, changed: false };
  const next = { ...header, cwd: newCwd };
  const plain = Buffer.from(JSON.stringify(next) + '\n', 'utf8');
  return { buf: Buffer.concat([zstdCompress(plain), ...frames.slice(1)]), header: next, changed: true };
}

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ───────────────────────────── 后端 ─────────────────────────────

export class LocalBackend {
  constructor(cfg) { this.root = cfg.path; }
  get label() { return `本地文件夹 ${this.root}`; }
  async init() { await fsp.mkdir(this.root, { recursive: true }); }
  async put(rel, buf) {
    const dest = path.join(this.root, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
  }
  async get(rel) {
    try { return await fsp.readFile(path.join(this.root, rel)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async has(rel) { return exists(path.join(this.root, rel)); }
  async list(rel) {
    try { return await fsp.readdir(path.join(this.root, rel)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
}

export class WebdavBackend {
  constructor(cfg) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.user = cfg.username || '';
    this.pass = cfg.password || '';
  }
  get label() { return `WebDAV ${this.base}`; }
  auth() {
    if (!this.user) return {};
    return { Authorization: `Basic ${Buffer.from(`${this.user}:${this.pass}`, 'utf8').toString('base64')}` };
  }
  url(rel) { return `${this.base}/${rel.split('/').map(encodeURIComponent).join('/')}`; }
  async init() {
    const r = await fetch(`${this.base}/dsh-sync`, { method: 'MKCOL', headers: this.auth() });
    if (!r.ok && r.status !== 405) throw new Error(`MKCOL 失败 ${r.status}`);
  }
  async put(rel, buf) {
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) {
      const u = `${this.base}/${segs.slice(0, i).map(encodeURIComponent).join('/')}`;
      await fetch(u, { method: 'MKCOL', headers: this.auth() }).catch(() => {});
    }
    const r = await fetch(this.url(rel), {
      method: 'PUT',
      headers: { ...this.auth(), 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    if (!r.ok) throw new Error(`PUT 失败 ${r.status} ${rel}`);
  }
  async get(rel) {
    const r = await fetch(this.url(rel), { headers: this.auth() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET 失败 ${r.status} ${rel}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async has(rel) {
    const r = await fetch(this.url(rel), { method: 'HEAD', headers: this.auth() });
    return r.ok;
  }
  async list(rel) {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
    const r = await fetch(this.url(rel), {
      method: 'PROPFIND',
      headers: { ...this.auth(), Depth: '1', 'Content-Type': 'application/xml' },
      body,
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`PROPFIND 失败 ${r.status} ${rel}`);
    const xml = await r.text();
    const basePath = decodeURIComponent(new URL(this.url(rel)).pathname).replace(/\/+$/, '');
    const names = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => {
      const href = decodeURIComponent(m[1]).replace(/\/+$/, '');
      return href.slice(href.lastIndexOf('/') + 1);
    }).filter(Boolean);
    return [...new Set(names)].filter((n) => !basePath.endsWith(n));
  }
}

export class S3Backend {
  constructor(cfg) {
    this.endpoint = cfg.endpoint.replace(/\/+$/, '');
    this.bucket = cfg.bucket;
    this.region = cfg.region || 'us-east-1';
    this.keyId = cfg.accessKeyId;
    this.secret = cfg.secretAccessKey;
    this.prefix = (cfg.prefix || 'dsh-sync').replace(/^\/+|\/+$/g, '');
  }
  get label() { return `S3 ${this.endpoint} / ${this.bucket}`; }
  async init() { /* 桶需预先创建 */ }
  full(rel) { return this.prefix ? `${this.prefix}/${rel}` : rel; }

  #sign(method, key, payloadHash, query = '') {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.endpoint).host;
    const canonicalUri = '/' + [this.bucket, ...key.split('/').filter(Boolean).map(encodeURIComponent)].join('/');
    const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const sorted = Object.keys(headers).sort();
    const canonicalHeaders = sorted.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sorted.join(';');
    const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.secret}`, dateStamp), this.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    return {
      url: `${this.endpoint}${canonicalUri}${query ? '?' + query : ''}`,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
  }

  async put(rel, buf) {
    const { url, headers } = this.#sign('PUT', this.full(rel), sha256(buf));
    const r = await fetch(url, { method: 'PUT', headers, body: buf });
    if (!r.ok) throw new Error(`PUT 失败 ${r.status} ${rel}`);
  }
  async get(rel) {
    const { url, headers } = this.#sign('GET', this.full(rel), sha256(Buffer.alloc(0)));
    const r = await fetch(url, { method: 'GET', headers });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET 失败 ${r.status} ${rel}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async has(rel) {
    const { url, headers } = this.#sign('HEAD', this.full(rel), sha256(Buffer.alloc(0)));
    const r = await fetch(url, { method: 'HEAD', headers });
    return r.ok;
  }
  async list(rel) {
    const prefix = this.full(rel ? rel + '/' : '');
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    const { url, headers } = this.#sign('GET', '', sha256(Buffer.alloc(0)), query);
    const r = await fetch(url, { method: 'GET', headers });
    if (!r.ok) throw new Error(`LIST 失败 ${r.status}`);
    const xml = await r.text();
    return [...new Set([...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => {
      const rest = m[1].slice(prefix.length);
      return rest.split('/')[0];
    }).filter(Boolean))];
  }
}

export function makeBackend(cfg) {
  if (!cfg || !cfg.backend) throw new Error('还没有配置同步位置');
  switch (cfg.backend) {
    case 'local': return new LocalBackend(cfg);
    case 'webdav': return new WebdavBackend(cfg);
    case 's3': return new S3Backend(cfg);
    default: throw new Error(`未知的同步方式：${cfg.backend}`);
  }
}

// ───────────────────────────── 清单 ─────────────────────────────

export function emptyManifest() {
  return { tool: 'dsh-sync', version: TOOL_VERSION, updatedAt: null, sessions: {} };
}

export async function readManifest(backend) {
  const buf = await backend.get(MANIFEST_NAME);
  if (!buf) return emptyManifest();
  try { return JSON.parse(buf.toString('utf8')); }
  catch { return emptyManifest(); }
}

// ───────────────────────────── 扫描 ─────────────────────────────

export async function scanSessions(dshHome, { withEvents = false } = {}) {
  const root = path.join(dshHome, 'sessions');
  const out = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return out; }

  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(root, proj.name);
    let sessions;
    try { sessions = await fsp.readdir(projDir, { withFileTypes: true }); }
    catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const dir = path.join(projDir, s.name);
      const files = await fsp.readdir(dir).catch(() => []);
      const logs = files.filter((f) => LOG_NAME_RE.test(f)).sort();
      if (logs.length === 0) continue;
      const logName = logs[logs.length - 1];
      const logFile = path.join(dir, logName);
      const st = await fsp.stat(logFile);
      let header;
      try { header = readHeader(logFile); }
      catch (e) {
        out.push({ id: s.name, broken: String(e.message || e), dir, logFile, logName, size: st.size });
        continue;
      }
      const rec = {
        id: header.id,
        cwd: header.cwd,
        parent: header.parentSession || null,
        preset: header.agentPreset || null,
        projectDir: proj.name,
        dir, logFile, logName,
        size: st.size,
        header,
      };
      if (withEvents) {
        const buf = await fsp.readFile(logFile);
        rec.events = Math.max(0, splitFrames(buf).length - 1);
      }
      out.push(rec);
    }
  }
  return out;
}

export async function scanAttachments(dshHome, sessions) {
  const objRoot = path.join(dshHome, 'attachments', 'v1', 'objects');
  const refs = new Set();
  for (const s of sessions) {
    if (!s.logFile) continue;
    let buf;
    try { buf = await fsp.readFile(s.logFile); } catch { continue; }
    const text = Buffer.concat(splitFrames(buf).map((f) => {
      try { return zlib.zstdDecompressSync(f); } catch { return Buffer.alloc(0); }
    })).toString('utf8');
    for (const m of text.matchAll(/"attachmentId"\s*:\s*"([^"]+)"/g)) {
      refs.add(m[1].replace(/^sha256:/, ''));
    }
  }
  const found = [];
  for (const id of refs) {
    const p = path.join(objRoot, id.slice(0, 2), id);
    if (await exists(p)) found.push({ id, path: p, size: (await fsp.stat(p)).size });
  }
  return { refs: [...refs], found };
}

// ───────────────────────────── 备份 ─────────────────────────────

/**
 * @param {object} cfg
 * @param {(evt: {type: string, [k: string]: any}) => void} emit 进度回调
 */
export async function doBackup(cfg, emit = () => {}) {
  const dshHome = cfg.dshHome || defaultDshHome();
  const backend = makeBackend(cfg);
  await backend.init();

  emit({ type: 'log', level: 'info', text: `DSH 目录：${dshHome}` });
  emit({ type: 'log', level: 'info', text: `同步位置：${backend.label}` });

  const sessions = await scanSessions(dshHome, { withEvents: true });
  if (sessions.length === 0) {
    emit({ type: 'log', level: 'warn', text: '本机没有找到任何会话。' });
    return { uploaded: 0, skipped: 0, bytes: 0, total: 0 };
  }

  const broken = sessions.filter((s) => s.broken);
  if (broken.length) {
    emit({ type: 'log', level: 'warn', text: `有 ${broken.length} 个会话读不出来，已跳过：${broken.map((b) => b.id).join(', ')}` });
  }

  const good = sessions.filter((s) => !s.broken);
  const manifest = await readManifest(backend);

  let uploaded = 0, skipped = 0, bytes = 0;
  const total = good.length;

  for (let i = 0; i < total; i++) {
    const s = good[i];
    const rel = `sessions/${s.id}.zstd`;
    const buf = await fsp.readFile(s.logFile);
    const digest = sha256(buf);
    const known = manifest.sessions?.[s.id];

    emit({ type: 'progress', phase: 'sessions', done: i, total, id: s.id });

    if (known && known.sha256 === digest && (await backend.has(rel))) {
      skipped++;
      emit({ type: 'log', level: 'dim', text: `${s.id} 没变，跳过` });
      continue;
    }
    await backend.put(rel, buf);
    bytes += buf.length;
    manifest.sessions[s.id] = {
      cwd: s.cwd, parent: s.parent, preset: s.preset,
      logName: s.logName, events: s.events,
      size: buf.length, sha256: digest,
      updatedAt: new Date().toISOString(),
    };
    uploaded++;
    emit({ type: 'log', level: 'ok', text: `${s.id}  ${humanSize(buf.length)}` });
  }
  emit({ type: 'progress', phase: 'sessions', done: total, total });

  // 附件
  emit({ type: 'log', level: 'info', text: '检查附件…' });
  const { refs, found } = await scanAttachments(dshHome, good);
  let attUp = 0;
  for (let i = 0; i < found.length; i++) {
    const a = found[i];
    emit({ type: 'progress', phase: 'attachments', done: i, total: found.length });
    const rel = `attachments/${a.id}`;
    if (await backend.has(rel)) continue;
    await backend.put(rel, await fsp.readFile(a.path));
    attUp++;
    bytes += a.size;
  }
  emit({ type: 'progress', phase: 'attachments', done: found.length, total: found.length });
  if (refs.length) {
    emit({ type: 'log', level: 'info', text: `附件：引用 ${refs.length} 个，本地有 ${found.length} 个，新上传 ${attUp} 个` });
    if (found.length < refs.length) {
      emit({ type: 'log', level: 'warn', text: `有 ${refs.length - found.length} 个附件在本机已经丢了` });
    }
  }

  const presets = [...new Set(good.map((s) => s.preset).filter(Boolean))];
  manifest.presets = presets;
  manifest.updatedAt = new Date().toISOString();
  manifest.origin = { dshHome, platform: process.platform, hostname: os.hostname() };
  await backend.put(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  const result = { uploaded, skipped, bytes, total: good.length, presets, attachments: attUp };
  emit({ type: 'done', op: 'backup', result });
  return result;
}

// ───────────────────────────── 还原 ─────────────────────────────

export function sortParentsFirst(sessions) {
  const done = new Set();
  const out = [];
  const visit = (id, guard = new Set()) => {
    if (done.has(id) || guard.has(id)) return;
    guard.add(id);
    const p = sessions[id]?.parent;
    if (p && sessions[p]) visit(p, guard);
    done.add(id);
    out.push(id);
  };
  for (const id of Object.keys(sessions)) visit(id);
  return out;
}

export async function doRestore(cfg, targetCwd, emit = () => {}) {
  const dshHome = cfg.dshHome || defaultDshHome();
  const backend = makeBackend(cfg);
  const sessionsRoot = path.join(dshHome, 'sessions');

  emit({ type: 'log', level: 'info', text: `DSH 目录：${dshHome}` });
  emit({ type: 'log', level: 'info', text: `同步位置：${backend.label}` });

  const manifestBuf = await backend.get(MANIFEST_NAME);
  if (!manifestBuf) throw new Error('同步位置里没有找到备份，先在有会话的电脑上做一次备份。');

  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  const ids = Object.keys(manifest.sessions || {});
  if (ids.length === 0) throw new Error('备份里没有会话。');

  if (!targetCwd) {
    const cwds = [...new Set(Object.values(manifest.sessions).map((s) => s.cwd).filter(Boolean))];
    targetCwd = cwds[0] || path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');
  }

  emit({ type: 'log', level: 'info', text: `目标工作目录：${targetCwd}` });
  await fsp.mkdir(targetCwd, { recursive: true });

  // 现有会话挪走，绝不直接删
  let trash = null;
  if (await exists(sessionsRoot)) {
    trash = path.join(dshHome, `.dsh-sync-trash-${stamp()}`);
    await fsp.rename(sessionsRoot, trash);
    emit({ type: 'log', level: 'warn', text: `原有会话已挪到：${trash}` });
  }
  await fsp.mkdir(sessionsRoot, { recursive: true });

  const projDir = path.join(sessionsRoot, projectKey(targetCwd));
  await fsp.mkdir(projDir, { recursive: true });

  const order = sortParentsFirst(manifest.sessions);
  let restored = 0, rewritten = 0, missing = 0;

  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const meta = manifest.sessions[id];
    emit({ type: 'progress', phase: 'sessions', done: i, total: order.length, id });

    const buf = await backend.get(`sessions/${id}.zstd`);
    if (!buf) {
      emit({ type: 'log', level: 'bad', text: `备份里缺 ${id}，跳过` });
      missing++;
      continue;
    }

    const dir = path.join(projDir, encodeSegment(id));
    await fsp.mkdir(dir, { recursive: true });
    const logName = meta.logName || 'session.v4.jsonl.zstd';

    let out = buf;
    if (meta.cwd !== targetCwd) {
      try {
        const r = rewriteHeaderCwd(buf, targetCwd);
        out = r.buf;
        if (r.changed) rewritten++;
      } catch (e) {
        emit({ type: 'log', level: 'warn', text: `${id} 的 header 改不动：${e.message}` });
      }
    }
    await fsp.writeFile(path.join(dir, logName), out);
    restored++;
    emit({ type: 'log', level: 'dim', text: `${id}  ${humanSize(out.length)}${meta.cwd !== targetCwd ? '  (已改路径)' : ''}` });
  }
  emit({ type: 'progress', phase: 'sessions', done: order.length, total: order.length });

  // 附件
  emit({ type: 'log', level: 'info', text: '还原附件…' });
  const attRoot = path.join(dshHome, 'attachments', 'v1', 'objects');
  await fsp.mkdir(attRoot, { recursive: true });
  const attNames = (await backend.list('attachments')).filter((n) => /^[0-9a-f]{64}$/.test(n));
  let attDone = 0;
  for (let i = 0; i < attNames.length; i++) {
    const name = attNames[i];
    emit({ type: 'progress', phase: 'attachments', done: i, total: attNames.length });
    const dest = path.join(attRoot, name.slice(0, 2), name);
    if (await exists(dest)) continue;
    const buf = await backend.get(`attachments/${name}`);
    if (!buf) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    attDone++;
  }
  emit({ type: 'progress', phase: 'attachments', done: attNames.length, total: attNames.length });

  // 清掉与路径绑定的缓存
  const projCache = path.join(dshHome, 'storages', 'session_projcache');
  if (await exists(projCache)) {
    await fsp.rm(projCache, { recursive: true, force: true });
    emit({ type: 'log', level: 'info', text: '已清空投影缓存（DSH 会自己重建）' });
  }
  const wsFile = path.join(dshHome, 'storages', 'workspace.json');
  if (await exists(wsFile)) {
    const bak = wsFile + '.dsh-sync.bak';
    await fsp.copyFile(wsFile, bak);
    await fsp.rm(wsFile, { force: true });
    emit({ type: 'log', level: 'info', text: '已重置工作区分组' });
  }

  const result = {
    restored, rewritten, missing, attachments: attDone,
    presets: manifest.presets || [], trash, targetCwd,
  };
  emit({ type: 'done', op: 'restore', result });
  return result;
}

// ───────────────────────────── 查看 / 体检 ─────────────────────────────

export async function doList(cfg) {
  const backend = makeBackend(cfg);
  const manifest = await readManifest(backend);
  const ids = Object.keys(manifest.sessions || {});
  const rows = ids.map((id) => {
    const m = manifest.sessions[id];
    return {
      id,
      short: id.length > 22 ? id.slice(0, 10) + '…' + id.slice(-8) : id,
      events: m.events ?? 0,
      size: m.size || 0,
      preset: m.preset || '-',
      cwd: m.cwd || '',
      isChild: !!m.parent,
      updatedAt: m.updatedAt || '',
    };
  }).sort((a, b) => b.events - a.events);
  return { label: backend.label, rows, updatedAt: manifest.updatedAt, presets: manifest.presets || [] };
}

export async function doDoctor(cfg) {
  const dshHome = cfg.dshHome || defaultDshHome();
  const checks = [];
  const add = (level, text) => checks.push({ level, text });

  add('info', `DSH 目录：${dshHome}`);
  if (!(await exists(dshHome))) {
    add('bad', '这个目录不存在，DSH 可能还没装或路径不对');
    return { checks };
  }
  add('ok', 'DSH 目录存在');

  const sessions = await scanSessions(dshHome, { withEvents: true });
  add('ok', `本机会话 ${sessions.length} 个`);
  const broken = sessions.filter((s) => s.broken);
  if (broken.length) add('bad', `其中 ${broken.length} 个读不出来：${broken.map((b) => b.id).join(', ')}`);
  else if (sessions.length) add('ok', '全部能正常读取');

  const children = sessions.filter((s) => s.parent);
  if (children.length) {
    const ids = new Set(sessions.map((s) => s.id));
    const orphan = children.filter((c) => !ids.has(c.parent));
    add('info', `子会话 ${children.length} 个`);
    if (orphan.length) add('bad', `有 ${orphan.length} 个子会话找不到父会话`);
    else add('ok', '子会话的父会话都在');
  }

  const { refs, found } = await scanAttachments(dshHome, sessions);
  if (refs.length) {
    if (found.length === refs.length) add('ok', `附件 ${refs.length} 个全部在位`);
    else add('bad', `附件引用 ${refs.length} 个，本地只有 ${found.length} 个`);
  }

  const presets = [...new Set(sessions.map((s) => s.preset).filter(Boolean))];
  if (presets.length) add('info', `用到预设：${presets.join(', ')}`);

  if (cfg && cfg.backend) {
    try {
      const backend = makeBackend(cfg);
      add('info', `同步位置：${backend.label}`);
      const manifest = await readManifest(backend);
      add('ok', `同步位置可访问，里面有 ${Object.keys(manifest.sessions || {}).length} 个会话`);
    } catch (e) {
      add('bad', `同步位置连不上：${e.message}`);
    }
  }

  return { checks };
}

/** 列出本机所有会话（给界面展示用） */
export async function listLocalSessions(dshHome) {
  const sessions = await scanSessions(dshHome, { withEvents: true });
  return sessions.map((s) => ({
    id: s.id,
    events: s.events ?? 0,
    size: s.size,
    preset: s.preset,
    cwd: s.cwd,
    isChild: !!s.parent,
    broken: s.broken || null,
  })).sort((a, b) => b.events - a.events);
}
