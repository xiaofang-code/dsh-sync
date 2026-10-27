#!/usr/bin/env node
/**
 * dsh-sync —— DSH 会话同步工具（小白版）
 *
 * 用法：
 *   node dsh-sync.mjs            交互菜单
 *   node dsh-sync.mjs backup     备份
 *   node dsh-sync.mjs restore    还原
 *   node dsh-sync.mjs list       查看备份
 *   node dsh-sync.mjs doctor     体检
 *
 * 设计原则：
 *   1. 默认什么都不删。还原前自动把现有 sessions 挪到 .dsh-sync-trash。
 *   2. 备份是「增量」的：内容寻址，同一个会话不会重复上传。
 *   3. 路径不一致自动改写 header.cwd，并同步重算目录名。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'dsh-sync.config.json');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TOOL_VERSION = 1;

// ────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[36m', gray: '\x1b[90m',
};
const ok = (s) => console.log(`${C.green}✓${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}!${C.reset} ${s}`);
const bad = (s) => console.log(`${C.red}✗${C.reset} ${s}`);
const info = (s) => console.log(`${C.blue}·${C.reset} ${s}`);
const dim = (s) => console.log(`${C.gray}${s}${C.reset}`);
const title = (s) => console.log(`\n${C.bold}${s}${C.reset}`);

function mb(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 把 ISO 时间变成文件名安全的串 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** DSH 的 projectKey：把 cwd 变成目录名 */
function projectKey(cwd) {
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
function encodeSegment(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

const LOG_NAME_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/u;

/** 切分 zstd 帧（DSH 的日志是「一帧一批」的追加文件） */
function splitFrames(buf) {
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

function zstdCompress(buf) {
  return zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
}

/** 读一个会话日志的 header（第一帧解压后的一行 JSON） */
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, chunk, 0, chunk.length, 0);
    const head = chunk.subarray(0, n);
    const frames = splitFrames(head);
    if (frames.length === 0) throw new Error('空文件');
    const text = zlib.zstdDecompressSync(frames[0]).toString('utf8');
    return JSON.parse(text.trim());
  } finally {
    fs.closeSync(fd);
  }
}

/** 改写日志里的 header.cwd，返回新 Buffer */
function rewriteHeaderCwd(buf, newCwd) {
  const frames = splitFrames(buf);
  if (frames.length === 0) throw new Error('空文件');
  const header = JSON.parse(zlib.zstdDecompressSync(frames[0]).toString('utf8').trim());
  if (header.cwd === newCwd) return { buf, header, changed: false };
  const next = { ...header, cwd: newCwd };
  const plain = Buffer.from(JSON.stringify(next) + '\n', 'utf8');
  const first = zstdCompress(plain);
  return { buf: Buffer.concat([first, ...frames.slice(1)]), header: next, changed: true };
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function walk(dir, onFile) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, onFile);
    else if (e.isFile()) await onFile(full);
  }
}

// ────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────

function defaultDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    bad(`配置文件坏了：${CONFIG_PATH}`);
    throw e;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  ok(`配置已保存：${CONFIG_PATH}`);
}

// ────────────────────────────────────────────────────────────
// 后端：本地文件夹 / WebDAV / S3
// ────────────────────────────────────────────────────────────

class LocalBackend {
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

class WebdavBackend {
  constructor(cfg) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.user = cfg.username || '';
    this.pass = cfg.password || '';
  }
  get label() { return `WebDAV ${this.base}`; }
  auth() {
    if (!this.user) return {};
    const token = Buffer.from(`${this.user}:${this.pass}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  url(rel) { return `${this.base}/${rel.split('/').map(encodeURIComponent).join('/')}`; }
  async init() {
    // 逐级 MKCOL，已存在会返回 405，忽略
    const parts = ['dsh-sync'];
    for (let i = 0; i < parts.length; i++) {
      const u = `${this.base}/${parts.slice(0, i + 1).map(encodeURIComponent).join('/')}`;
      const r = await fetch(u, { method: 'MKCOL', headers: this.auth() });
      if (!r.ok && r.status !== 405) throw new Error(`MKCOL 失败 ${r.status} ${u}`);
    }
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
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`;
    const r = await fetch(this.url(rel), {
      method: 'PROPFIND',
      headers: { ...this.auth(), Depth: '1', 'Content-Type': 'application/xml' },
      body,
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`PROPFIND 失败 ${r.status} ${rel}`);
    const xml = await r.text();
    const names = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => {
      const href = decodeURIComponent(m[1]).replace(/\/+$/, '');
      return href.slice(href.lastIndexOf('/') + 1);
    }).filter(Boolean);
    const self = decodeURIComponent(new URL(this.url(rel)).pathname).replace(/\/+$/, '').slice(-1 * (rel.length));
    return [...new Set(names)].filter((n) => n !== self && !rel.endsWith(n));
  }
}

class S3Backend {
  constructor(cfg) {
    this.endpoint = cfg.endpoint.replace(/\/+$/, '');
    this.bucket = cfg.bucket;
    this.region = cfg.region || 'us-east-1';
    this.keyId = cfg.accessKeyId;
    this.secret = cfg.secretAccessKey;
    this.prefix = (cfg.prefix || 'dsh-sync').replace(/^\/+|\/+$/g, '');
  }
  get label() { return `S3 ${this.endpoint} / ${this.bucket}`; }
  async init() { /* 桶需要预先创建 */ }

  sign(method, key, payloadHash) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.endpoint).host;
    const canonicalUri = '/' + [this.bucket, ...key.split('/').map(encodeURIComponent)].join('/');
    const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const kDate = hmac(`AWS4${this.secret}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    return {
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      url: `${this.endpoint}${canonicalUri}`,
    };
  }

  full(rel) { return this.prefix ? `${this.prefix}/${rel}` : rel; }

  async put(rel, buf) {
    const key = this.full(rel);
    const { headers, url } = this.sign('PUT', key, sha256(buf));
    const r = await fetch(url, { method: 'PUT', headers, body: buf });
    if (!r.ok) throw new Error(`PUT 失败 ${r.status} ${rel} ${await r.text().catch(() => '')}`);
  }
  async get(rel) {
    const key = this.full(rel);
    const emptyHash = sha256(Buffer.alloc(0));
    const { headers, url } = this.sign('GET', key, emptyHash);
    const r = await fetch(url, { method: 'GET', headers });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET 失败 ${r.status} ${rel}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async has(rel) {
    const key = this.full(rel);
    const { headers, url } = this.sign('HEAD', key, sha256(Buffer.alloc(0)));
    const r = await fetch(url, { method: 'HEAD', headers });
    return r.ok;
  }
  async list(rel) {
    const prefix = this.full(rel ? rel + '/' : '');
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    const emptyHash = sha256(Buffer.alloc(0));
    const key = '';
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.endpoint).host;
    const canonicalUri = '/' + this.bucket;
    const headers = { host, 'x-amz-content-sha256': emptyHash, 'x-amz-date': amzDate };
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = ['GET', canonicalUri, query, canonicalHeaders, signedHeaders, emptyHash].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonicalRequest))].join('\n');
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.secret}`, dateStamp), this.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const url = `${this.endpoint}${canonicalUri}?${query}`;
    const r = await fetch(url, {
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
    if (!r.ok) throw new Error(`LIST 失败 ${r.status}`);
    const xml = await r.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => {
      const k = m[1];
      const rest = prefix ? k.slice(prefix.length) : k;
      return rest.split('/')[0];
    }).filter((x) => x && !x.includes('/'));
  }
}

function makeBackend(cfg) {
  if (!cfg || !cfg.backend) throw new Error('还没有配置同步位置，请先运行「首次设置」');
  switch (cfg.backend) {
    case 'local': return new LocalBackend(cfg);
    case 'webdav': return new WebdavBackend(cfg);
    case 's3': return new S3Backend(cfg);
    default: throw new Error(`未知的同步方式：${cfg.backend}`);
  }
}

// ────────────────────────────────────────────────────────────
// 清单（manifest）—— 记录每个会话属于哪个 cwd、有多少事件
// ────────────────────────────────────────────────────────────

const MANIFEST_NAME = 'manifest.json';

function emptyManifest() {
  return { tool: 'dsh-sync', version: TOOL_VERSION, updatedAt: null, sessions: {} };
}

async function readManifest(backend) {
  const buf = await backend.get(MANIFEST_NAME);
  if (!buf) return emptyManifest();
  try { return JSON.parse(buf.toString('utf8')); }
  catch { return emptyManifest(); }
}

// ────────────────────────────────────────────────────────────
// 扫描本机会话
// ────────────────────────────────────────────────────────────

/**
 * 返回 [{ id, cwd, projectDir, dir, logFile, logName, size, header, events }]
 */
async function scanSessions(dshHome, { withEvents = false } = {}) {
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
      catch (e) { out.push({ id: s.name, broken: String(e.message || e), dir, logFile, logName, size: st.size }); continue; }
      const rec = {
        id: header.id,
        cwd: header.cwd,
        parent: header.parentSession || null,
        preset: header.agentPreset || null,
        projectDir: proj.name,
        dir,
        logFile,
        logName,
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

/** 收集会话里引用到的附件 id（去掉 sha256: 前缀） */
async function scanAttachments(dshHome, sessions) {
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

// ────────────────────────────────────────────────────────────
// 备份
// ────────────────────────────────────────────────────────────

async function doBackup(cfg, opts = {}) {
  const dshHome = cfg.dshHome || defaultDshHome();
  const backend = makeBackend(cfg);
  await backend.init();

  title('开始备份');
  info(`DSH 目录：${dshHome}`);
  info(`同步位置：${backend.label}`);

  const sessions = await scanSessions(dshHome, { withEvents: true });
  if (sessions.length === 0) { warn('本机没有找到任何会话，没什么可备份的。'); return { uploaded: 0, skipped: 0 }; }

  const broken = sessions.filter((s) => s.broken);
  if (broken.length) warn(`有 ${broken.length} 个会话读不出来，已跳过：${broken.map((b) => b.id).join(', ')}`);

  const good = sessions.filter((s) => !s.broken);
  const manifest = await readManifest(backend);
  const remoteIds = new Set(Object.keys(manifest.sessions || {}));

  let uploaded = 0, skipped = 0, bytes = 0;
  const total = good.length;
  let i = 0;

  for (const s of good) {
    i++;
    const rel = `sessions/${s.id}.zstd`;
    const buf = await fsp.readFile(s.logFile);
    const digest = sha256(buf);
    const known = manifest.sessions?.[s.id];

    const prefix = `[${String(i).padStart(String(total).length)}/${total}]`;
    if (known && known.sha256 === digest && (await backend.has(rel))) {
      skipped++;
      dim(`${prefix} ${s.id} 没变，跳过`);
      continue;
    }
    await backend.put(rel, buf);
    bytes += buf.length;
    manifest.sessions[s.id] = {
      cwd: s.cwd,
      parent: s.parent,
      preset: s.preset,
      logName: s.logName,
      events: s.events,
      size: buf.length,
      sha256: digest,
      updatedAt: new Date().toISOString(),
    };
    uploaded++;
    ok(`${prefix} ${s.id}  ${mb(buf.length)}`);
  }

  // 附件
  const { refs, found } = await scanAttachments(dshHome, good);
  let attUp = 0;
  for (const a of found) {
    const rel = `attachments/${a.id}`;
    if (await backend.has(rel)) continue;
    await backend.put(rel, await fsp.readFile(a.path));
    attUp++;
    bytes += a.size;
  }
  if (refs.length) {
    info(`附件：引用 ${refs.length} 个，本地有 ${found.length} 个，新上传 ${attUp} 个`);
    if (found.length < refs.length) warn(`有 ${refs.length - found.length} 个附件在本机已经丢了（会话里还会显示占位）`);
  }

  // 预设
  const presets = [...new Set(good.map((s) => s.preset).filter(Boolean))];
  manifest.presets = presets;
  manifest.updatedAt = new Date().toISOString();
  manifest.origin = { dshHome, platform: process.platform, hostname: os.hostname() };
  await backend.put(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  title('备份完成');
  ok(`会话 ${good.length} 个：新上传 ${uploaded}，跳过 ${skipped}`);
  ok(`本次传输 ${mb(bytes)}`);
  if (presets.length) info(`这些会话用到预设：${presets.join(', ')}（另一台机器上要装同名预设）`);
  return { uploaded, skipped, bytes };
}

// ────────────────────────────────────────────────────────────
// 还原
// ────────────────────────────────────────────────────────────

async function doRestore(cfg, opts = {}) {
  const dshHome = cfg.dshHome || defaultDshHome();
  const backend = makeBackend(cfg);
  const sessionsRoot = path.join(dshHome, 'sessions');

  title('开始还原');
  info(`DSH 目录：${dshHome}`);
  info(`同步位置：${backend.label}`);

  const manifestBuf = await backend.get(MANIFEST_NAME);
  if (!manifestBuf) { bad('同步位置里没有找到备份，先在有会话的电脑上做一次「备份」。'); return; }

  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  const ids = Object.keys(manifest.sessions || {});
  if (ids.length === 0) { warn('备份里没有会话。'); return; }

  // 问一下要还原到哪个工作目录
  const targetCwd = opts.cwd || await askCwd(manifest, cfg);

  title(`准备还原 ${ids.length} 个会话`);
  info(`目标工作目录：${targetCwd}`);
  await fsp.mkdir(targetCwd, { recursive: true });

  // 现有 sessions 先挪走，绝不直接删
  if (await exists(sessionsRoot)) {
    const trash = path.join(dshHome, `.dsh-sync-trash-${stamp()}`);
    await fsp.rename(sessionsRoot, trash);
    warn(`原有会话已挪到：${trash}`);
    info('确认没问题后可以手动删掉它。');
  }
  await fsp.mkdir(sessionsRoot, { recursive: true });

  const projDirName = projectKey(targetCwd);
  const projDir = path.join(sessionsRoot, projDirName);
  await fsp.mkdir(projDir, { recursive: true });

  let restored = 0, rewritten = 0, missing = 0;
  const order = sortParentsFirst(manifest.sessions);

  for (const id of order) {
    const meta = manifest.sessions[id];
    const buf = await backend.get(`sessions/${id}.zstd`);
    if (!buf) { bad(`备份里缺 ${id}，跳过`); missing++; continue; }

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
        warn(`${id} 的 header 改不动：${e.message}`);
      }
    }
    await fsp.writeFile(path.join(dir, logName), out);
    restored++;
    dim(`  ${id}  ${mb(out.length)}${meta.cwd !== targetCwd ? '  (已改路径)' : ''}`);
  }

  // 附件
  const attRoot = path.join(dshHome, 'attachments', 'v1', 'objects');
  await fsp.mkdir(attRoot, { recursive: true });
  const attNames = await backend.list('attachments');
  let attDone = 0;
  for (const name of attNames) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const dest = path.join(attRoot, name.slice(0, 2), name);
    if (await exists(dest)) continue;
    const buf = await backend.get(`attachments/${name}`);
    if (!buf) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    attDone++;
  }
  if (attDone) ok(`附件还原 ${attDone} 个`);

  // 清掉与路径绑定的缓存，让 DSH 自己重建
  const projCache = path.join(dshHome, 'storages', 'session_projcache');
  if (await exists(projCache)) {
    await fsp.rm(projCache, { recursive: true, force: true });
    info('已清空投影缓存（DSH 会自己重建）');
  }
  const wsFile = path.join(dshHome, 'storages', 'workspace.json');
  if (await exists(wsFile)) {
    const bak = wsFile + '.dsh-sync.bak';
    await fsp.copyFile(wsFile, bak);
    await fsp.rm(wsFile, { force: true });
    info(`已重置工作区分组（旧的备份为 ${path.basename(bak)}）`);
  }

  title('还原完成');
  ok(`会话 ${restored} 个（其中 ${rewritten} 个改了工作目录路径）`);
  if (missing) bad(`缺 ${missing} 个`);
  if (manifest.presets?.length) {
    warn(`这些会话用到预设：${manifest.presets.join(', ')}`);
    info('如果这台机器没装对应预设，打开会话会报 agent-preset/not-found，装上就好。');
  }
  info('现在重启 DSH，会话列表里就能看到了。');
}

function sortParentsFirst(sessions) {
  const ids = Object.keys(sessions);
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
  for (const id of ids) visit(id);
  return out;
}

async function askCwd(manifest, cfg) {
  const cwds = [...new Set(Object.values(manifest.sessions || {}).map((s) => s.cwd).filter(Boolean))];
  // 自动化测试/脚本用：DSH_SYNC_CWD 直接指定，跳过提问
  if (process.env.DSH_SYNC_CWD) return process.env.DSH_SYNC_CWD;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (cwds.length === 1) {
      const old = cwds[0];
      const same = await exists(old);
      console.log('');
      info(`备份里的工作目录：${old}`);
      if (same) {
        const a = (await rl.question(`  用这个路径还原吗？[Y/n] `)).trim().toLowerCase();
        if (a === '' || a === 'y' || a === 'yes') return old;
      } else {
        warn('这个路径在本机不存在。');
      }
      const def = path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');
      const input = (await rl.question(`  请输入本机要用的工作目录 [默认 ${def}]：`)).trim();
      return input || def;
    }
    console.log('');
    info('备份里包含多个工作目录：');
    cwds.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    const def = path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');
    const input = (await rl.question(`  统一还原到哪个目录？[默认 ${def}]：`)).trim();
    return input || def;
  } finally {
    rl.close();
  }
}

// ────────────────────────────────────────────────────────────
// 查看 / 体检
// ────────────────────────────────────────────────────────────

async function doList(cfg) {
  const backend = makeBackend(cfg);
  title('同步位置里的备份');
  info(backend.label);
  const manifest = await readManifest(backend);
  const ids = Object.keys(manifest.sessions || {});
  if (ids.length === 0) { warn('空的，还没有备份。'); return; }

  const rows = ids.map((id) => {
    const m = manifest.sessions[id];
    return {
      id: id.length > 20 ? id.slice(0, 8) + '…' + id.slice(-8) : id,
      events: m.events ?? '?',
      size: mb(m.size || 0),
      preset: m.preset || '-',
      cwd: (m.cwd || '').split(/[\\/]/).pop() || '-',
      parent: m.parent ? '子会话' : '',
    };
  }).sort((a, b) => String(b.events).localeCompare(String(a.events), undefined, { numeric: true }));

  console.table(rows);
  ok(`共 ${ids.length} 个会话，最后更新 ${manifest.updatedAt || '未知'}`);
  if (manifest.presets?.length) info(`涉及预设：${manifest.presets.join(', ')}`);
}

async function doDoctor(cfg) {
  const dshHome = cfg.dshHome || defaultDshHome();
  title('体检');
  info(`DSH 目录：${dshHome}`);

  if (!(await exists(dshHome))) { bad('这个目录不存在，DSH 可能还没装或路径不对。'); return; }
  ok('DSH 目录存在');

  const sessions = await scanSessions(dshHome, { withEvents: true });
  ok(`本机会话 ${sessions.length} 个`);
  const broken = sessions.filter((s) => s.broken);
  if (broken.length) bad(`其中 ${broken.length} 个读不出来：${broken.map((b) => b.id).join(', ')}`);
  else ok('全部能正常读取');

  const children = sessions.filter((s) => s.parent);
  if (children.length) {
    const parentIds = new Set(sessions.map((s) => s.id));
    const orphan = children.filter((c) => !parentIds.has(c.parent));
    info(`子会话 ${children.length} 个`);
    if (orphan.length) bad(`有 ${orphan.length} 个子会话找不到父会话：${orphan.map((o) => o.id).join(', ')}`);
    else ok('子会话的父会话都在');
  }

  const { refs, found } = await scanAttachments(dshHome, sessions);
  if (refs.length) {
    if (found.length === refs.length) ok(`附件 ${refs.length} 个全部在位`);
    else bad(`附件引用 ${refs.length} 个，本地只有 ${found.length} 个`);
  }

  const presets = [...new Set(sessions.map((s) => s.preset).filter(Boolean))];
  if (presets.length) info(`用到预设：${presets.join(', ')}`);

  const backend = makeBackend(cfg);
  info(`同步位置：${backend.label}`);
  try {
    const manifest = await readManifest(backend);
    const n = Object.keys(manifest.sessions || {}).length;
    ok(`同步位置可访问，里面有 ${n} 个会话`);
  } catch (e) {
    bad(`同步位置连不上：${e.message}`);
  }
}

// ────────────────────────────────────────────────────────────
// 首次设置
// ────────────────────────────────────────────────────────────

async function doSetup() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    title('首次设置');
    console.log('先选同步方式：');
    console.log(`  ${C.bold}1${C.reset}. 本地文件夹 / U盘 / 移动硬盘  ${C.gray}(最简单，推荐)${C.reset}`);
    console.log(`  ${C.bold}2${C.reset}. 坚果云 / Nextcloud 等 WebDAV 网盘`);
    console.log(`  ${C.bold}3${C.reset}. S3 兼容对象存储（阿里云 OSS / 腾讯云 COS / MinIO）`);
    console.log(`  ${C.bold}4${C.reset}. 一键云盘（OneDrive / 坚果云 同步文件夹）  ${C.gray}—— 选 1 就行${C.reset}`);
    const choice = (await rl.question(`\n请输入编号 [1]：`)).trim() || '1';

    const cfg = { dshHome: defaultDshHome() };

    if (choice === '1' || choice === '4') {
      const def = path.join(os.homedir(), 'dsh-sync-data');
      const p = (await rl.question(`备份存到哪个文件夹？[默认 ${def}]：`)).trim() || def;
      cfg.backend = 'local';
      cfg.path = p;
      console.log('');
      info('提示：如果你把这个文件夹放在 OneDrive / 坚果云 的同步目录里，');
      info('      云盘客户端会自动帮你传到云端，效果一样。');
    } else if (choice === '2') {
      cfg.backend = 'webdav';
      cfg.url = (await rl.question('WebDAV 地址（例如 https://dav.jianguoyun.com/dav/dsh）：')).trim();
      cfg.username = (await rl.question('用户名：')).trim();
      cfg.password = (await rl.question('密码 / 应用密码：')).trim();
    } else if (choice === '3') {
      cfg.backend = 's3';
      cfg.endpoint = (await rl.question('Endpoint（例如 https://oss-cn-hangzhou.aliyuncs.com）：')).trim();
      cfg.bucket = (await rl.question('Bucket 名：')).trim();
      cfg.region = (await rl.question('Region [us-east-1]：')).trim() || 'us-east-1';
      cfg.accessKeyId = (await rl.question('AccessKeyId：')).trim();
      cfg.secretAccessKey = (await rl.question('AccessKeySecret：')).trim();
      cfg.prefix = (await rl.question('前缀目录 [dsh-sync]：')).trim() || 'dsh-sync';
    } else {
      bad('编号不对，重来。');
      return;
    }

    const dh = (await rl.question(`\nDSH 数据目录 [默认 ${cfg.dshHome}]：`)).trim();
    if (dh) cfg.dshHome = dh;

    saveConfig(cfg);
    console.log('');
    ok('设置好了。接下来选「备份」或「还原」。');
  } finally {
    rl.close();
  }
}

// ────────────────────────────────────────────────────────────
// 主菜单
// ────────────────────────────────────────────────────────────

async function menu() {
  for (;;) {
    const cfg = loadConfig();
    console.log('');
    console.log(`${C.bold}════════ DSH 会话同步 ════════${C.reset}`);
    if (cfg) {
      dim(`  同步到：${makeBackend(cfg).label}`);
      dim(`  DSH 目录：${cfg.dshHome || defaultDshHome()}`);
    } else {
      warn('  还没设置过，请先选 0');
    }
    console.log('');
    console.log(`  ${C.bold}0${C.reset}. 首次设置 / 改设置`);
    console.log(`  ${C.bold}1${C.reset}. 备份  ${C.gray}(把这台电脑的会话传上去)${C.reset}`);
    console.log(`  ${C.bold}2${C.reset}. 还原  ${C.gray}(把会话拉到这台电脑)${C.reset}`);
    console.log(`  ${C.bold}3${C.reset}. 看看备份里有什么`);
    console.log(`  ${C.bold}4${C.reset}. 体检  ${C.gray}(检查会话有没有坏)${C.reset}`);
    console.log(`  ${C.bold}q${C.reset}. 退出`);

    const rl = readline.createInterface({ input: stdin, output: stdout });
    let ans;
    try { ans = (await rl.question(`\n选一个：`)).trim().toLowerCase(); }
    finally { rl.close(); }

    if (ans === 'q' || ans === 'quit' || ans === 'exit') return;
    if (ans === '0') { await doSetup(); continue; }
    if (!cfg && ans !== '0') { bad('先做首次设置（选 0）。'); continue; }

    try {
      if (ans === '1') await doBackup(cfg);
      else if (ans === '2') await doRestore(cfg);
      else if (ans === '3') await doList(cfg);
      else if (ans === '4') await doDoctor(cfg);
      else warn('没这个选项。');
    } catch (e) {
      console.log('');
      bad(e.message || String(e));
      if (process.env.DSH_SYNC_DEBUG) console.error(e);
    }
  }
}

// ────────────────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────────────────

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();

  if (!cmd) {
    if (!loadConfig()) { await doSetup(); }
    await menu();
    return;
  }

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(`用法：
  node dsh-sync.mjs            交互菜单（推荐）
  node dsh-sync.mjs setup      首次设置
  node dsh-sync.mjs backup     备份
  node dsh-sync.mjs restore    还原
  node dsh-sync.mjs list       查看备份
  node dsh-sync.mjs doctor     体检`);
    return;
  }

  const cfg = loadConfig();
  if (!cfg && cmd !== 'setup') {
    bad('还没设置过。先运行：node dsh-sync.mjs setup');
    process.exitCode = 1;
    return;
  }

  switch (cmd) {
    case 'setup': await doSetup(); break;
    case 'backup': case 'push': await doBackup(cfg); break;
    case 'restore': case 'pull': await doRestore(cfg); break;
    case 'list': case 'ls': await doList(cfg); break;
    case 'doctor': case 'check': await doDoctor(cfg); break;
    default:
      bad(`不认识的命令：${cmd}（用 help 看用法）`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log('');
  bad(e.stack || String(e));
  process.exitCode = 1;
});
