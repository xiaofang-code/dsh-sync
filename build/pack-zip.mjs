/**
 * 打成交付压缩包：一个 zip，用户解压后双击里面的「启动.cmd」就能用。
 *
 * 为什么不用单文件 exe（试过，都不可靠）：
 *   1. .NET 单文件发布 —— 200MB+ 时启动静默失败
 *   2. 7z.sfx 自解压 —— 卡在隐藏的 GUI 对话框上，无人值守必卡死
 *   3. IExpress —— 356MB 打包直接失败（CAB 限制）
 *
 * zip + cmd 是最朴素但 100% 可靠的方式。
 *
 * 用法：node build/pack-zip.mjs
 * 前置：先跑 node build/pack.mjs 生成 dist 目录
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
// exe 用纯 ASCII 名，避免 .cmd / 旧解压工具的编码问题
const EXE_NAME = 'DSH_Sync';
const ZIP_NAME = 'DSH会话同步';

const SEVEN_ZIP_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
];
const sevenZip = SEVEN_ZIP_CANDIDATES.find((p) => fs.existsSync(p));
const SRC = path.join(OUT, `${EXE_NAME}-win32-x64`);

if (!fs.existsSync(SRC)) {
  console.error(`找不到已打包的程序目录：${SRC}`);
  console.error('先运行：node build/pack.mjs');
  process.exit(1);
}

// ── 1. 生成启动脚本 ───────────────────────────────────────
//
// 关键：.cmd 必须用 GBK(936) 编码 + CRLF 换行，且内容全 ASCII。
// 用 UTF-8 写中文注释会导致 cmd.exe 解析错乱，文件名变乱码、脚本失效。

const launcher = [
  '@echo off',
  'rem Clear ELECTRON_RUN_AS_NODE which forces Electron into Node-only mode.',
  'set "ELECTRON_RUN_AS_NODE="',
  'cd /d "%~dp0"',
  `start "" "%~dp0${EXE_NAME}.exe"`,
  '',
].join('\r\n');

fs.writeFileSync(path.join(SRC, '启动.cmd'), Buffer.from(launcher, 'latin1'));

// ── 2. 放一份使用说明 ─────────────────────────────────────

const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme)) {
  fs.copyFileSync(readme, path.join(SRC, '使用说明.md'));
}

// ── 3. 压缩 ───────────────────────────────────────────────

const target = path.join(OUT, `${ZIP_NAME}.zip`);
if (fs.existsSync(target)) fs.rmSync(target, { force: true });

if (sevenZip) {
  console.log('用 7-Zip 压缩…');
  execFileSync(sevenZip, [
    'a', '-tzip', '-mx=5', '-mmt=on', '-bso0', '-bsp0',
    target, path.join(SRC, '*'),
  ], { stdio: 'inherit' });
} else {
  console.log('用 PowerShell 压缩…');
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${SRC}\\*' -DestinationPath '${target}' -Force`,
  ], { stdio: 'inherit' });
}

if (!fs.existsSync(target)) {
  console.error('压缩失败');
  process.exit(1);
}

const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);

console.log('');
console.log(`✓ 交付包：${target}`);
console.log(`  大小：${mb} MB`);
console.log('');
console.log('把这个 zip 发给别人，对方解压后双击「启动.cmd」即可。');
