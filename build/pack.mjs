/**
 * 打包脚本：把 Electron 应用打成 Windows exe。
 * 用法：node build/pack.mjs
 *
 * 输出：
 *   dist/DSH会话同步-win32-x64/DSH会话同步.exe   ← 绿色版，整个文件夹拷走就能用
 */

import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
// exe 文件名用纯 ASCII：中文文件名在 .cmd 批处理、旧版解压工具里容易乱码
const NAME = 'DSH_Sync';
const DISPLAY_NAME = 'DSH 会话同步';
const ICO = path.join(ROOT, 'build', 'icon.ico');

const opts = {
  dir: ROOT,
  out: OUT,
  name: NAME,
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  appVersion: '1.0.0',
  appCopyright: 'MIT',
  asar: true,
  prune: true,
  ignore: [
    /^\/dist($|\/)/,
    /^\/build($|\/)/,
    /^\/dsh-sync\.mjs$/,
    /^\/启动\.cmd$/,
    /^\/node_modules\/\.cache($|\/)/,
    /^\/\.git($|\/)/,
  ],
  win32metadata: {
    CompanyName: 'YG',
    FileDescription: DISPLAY_NAME,
    ProductName: DISPLAY_NAME,
    InternalName: 'dsh-sync',
    OriginalFilename: `${NAME}.exe`,
  },
};

if (fs.existsSync(ICO)) opts.icon = ICO;

console.log('打包中…');
const [outDir] = await packager(opts);

const exe = path.join(outDir, `${NAME}.exe`);
if (!fs.existsSync(exe)) {
  console.error('没找到 exe，检查一下输出目录');
  process.exit(1);
}

const exeMb = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);

// 统计整个目录大小
let total = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
};
walk(outDir);

// 放一份使用说明进去
const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme)) {
  fs.copyFileSync(readme, path.join(outDir, '使用说明.md'));
}

console.log('');
console.log(`输出目录：${outDir}`);
console.log(`主程序：  ${exe}  (${exeMb} MB)`);
console.log(`整个目录：${(total / 1024 / 1024).toFixed(1)} MB`);
console.log('');
console.log('整个文件夹拷到别的电脑就能用，不需要装 Node.js。');
