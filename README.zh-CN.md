# DSH 会话同步

**把 DeepSeek Harness 的聊天记录在电脑之间搬来搬去。不用 git，不用命令行，不用云账号。**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)]()
[![Electron](https://img.shields.io/badge/electron-45-47848f)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

[English](README.md)

---

## 要解决什么问题

DeepSeek Harness（DSH）把每个会话存成 zstd 压缩的追加式日志，放在 `~/.dsh/sessions/` 下。这些日志**默认不可移植**：

- 目录名由工作目录路径算出来：`--C-Users-You-Documents-project--`
- 日志第一帧（header）里存着同一个绝对路径 `cwd`
- DSH 读取时会用 header 重算目录名，对不上就报 `corrupt session log`

所以把 `~/.dsh` 直接拷到另一台用户名不同的电脑上，所有会话都会静默损坏。这个工具就是解决这件事的。

## 功能

| 特性 | 说明 |
|---|---|
| **存储无关** | 本地文件夹、U 盘、OneDrive/坚果云同步目录、WebDAV、S3 兼容对象存储 |
| **路径改写** | 自动改写 `header.cwd` 并重新推导项目目录名 |
| **增量** | 按 SHA-256 判断，没变的会话直接跳过 |
| **附件** | 内容寻址（`sha256`），天然去重，跟会话一起同步 |
| **父会话优先** | 子代理会话一定在父会话之后写入 |
| **清缓存** | 清掉 `session_projcache` 和 `workspace.json`，让 DSH 按新路径重建 |
| **不删东西** | 现有会话改名为 `.dsh-sync-trash-<时间戳>`，从不删除 |
| **零依赖** | 单文件 CLI + Electron 界面，不需要任何外部运行时 |

## 界面截图

### 首页 —— 本机有什么

![首页](docs/screenshots/home.png)

### 备份 —— 把会话推到存储位置

![备份](docs/screenshots/backup-running.png)

### 还原 —— 拉取会话并改写路径

![还原](docs/screenshots/restore.png)

### 查看备份 —— 检查远端清单

![查看备份](docs/screenshots/browse.png)

### 体检 —— 校验日志、附件、连通性

![体检](docs/screenshots/doctor-result.png)

### 设置 —— 选择同步方式

![设置](docs/screenshots/settings.png)

## 快速开始

### 方式 A —— 用打好的包（Windows）

1. 从 [Releases](../../releases) 下载 `DSH会话同步.zip`
2. **右键 → 全部解压**（不要直接在压缩包里双击）
3. 双击 `启动.cmd`

> **为什么不能只发 exe？**
> 这是 Electron 应用，`DSH_Sync.exe` 只是外壳，启动时要读同目录的
> `resources/app.asar`、`locales/` 和约 70 个 DLL/PAK 文件。
> 只拷 exe 出去，双击会瞬间退出、没有窗口。
> **必须整个文件夹一起发，或者发那个 zip。**

### 方式 B —— 从源码跑

```bash
git clone https://github.com/<you>/dsh-sync.git
cd dsh-sync
npm install
npm start          # 开发模式启动界面
```

打包：

```bash
node build/make-icon.mjs   # 生成 build/icon.ico
node build/pack.mjs        # → dist/DSH_Sync-win32-x64/
node build/pack-zip.mjs    # → dist/DSH会话同步.zip
```

### 方式 C —— 只用命令行（不需要 Electron）

```bash
node dsh-sync.mjs setup      # 交互式首次设置
node dsh-sync.mjs backup     # 备份
node dsh-sync.mjs restore    # 还原
node dsh-sync.mjs list       # 看远端清单
node dsh-sync.mjs doctor     # 体检
```

## 使用流程

### 首次运行

打开就是**设置**页，选一种同步方式：

**本地文件夹**（最简单）—— 任意目录。放在 U 盘、局域网共享、或者 OneDrive/坚果云的同步目录里，云盘客户端会帮你传输。

**WebDAV** —— Nextcloud、坚果云、群晖等。

**S3 兼容** —— AWS S3、阿里云 OSS、腾讯云 COS、MinIO。

再设置 **DSH 数据目录**（默认 `%USERPROFILE%\.dsh`），保存。

### A 电脑 —— 备份

左侧「备份」→「开始备份」。

```
✓ session-5c0eb59e-...  3.4 MB
✓ 225bd316-...          744.7 KB
...
备份完成
✓ 会话 25 个：新上传 25，跳过 0
✓ 本次传输 20.5 MB
```

第二次跑会跳过所有没变的会话。

### B 电脑 —— 还原

先在设置里指向同一个存储位置，然后左侧「还原」。

- **用户名相同** → 工作目录路径不用改
- **用户名不同** → 改一下路径，工具会改写每个会话的 header

```
还原完成
✓ 会话 25 个（其中 25 个改了工作目录路径）
· 现在重启 DSH，会话列表里就能看到了。
```

### 重启 DSH

关掉再打开，会话出现在侧栏，点开能接着聊。

## 路径改写是怎么做的

DSH 的磁盘不变量：

```
sessions/<projectKey(header.cwd)>/<encodeSegment(header.id)>/session.v4.jsonl.zstd
```

`projectKey` 把 `/ \ :` 映射成 `-`，保留 `[A-Za-z0-9._-]`，其余字符转义成 `~XXXX`（大写十六进制）。读取时 `assertStoredIdentity` 会重算一遍并比对。

工具的做法：

1. 按 magic（`28 b5 2f fd`）把日志切成 zstd 帧
2. **只解压第 0 帧**（header），改写 `cwd`，用同样的参数重新压缩（`ZSTD_c_checksumFlag: 1`）
3. 新 header 与未改动的事件帧拼接
4. 写进由新路径推导出的项目目录

事件帧是纯追加的历史，不含任何路径信息，所以保持字节不变。结果与原生写入的会话无法区分 —— 已用 DSH 自己的 `persistence.open(id, 'read')` 逐个打开验证过。

## 什么不同步

| 跳过 | 原因 |
|---|---|
| `.credentials.yaml` | API Key 留在本地 |
| `profiles/*/cordis.patch.yml` | 模型/供应商配置因机器而异 |
| `cache/`、`dsh-runtimes/` | 可以重建 |
| `profiles/*/node_modules/` | 几百 MB，重装更划算 |

## 注意事项

**备份前关掉 DSH。** 会话是追加写的，运行中读取通常也没问题，但关掉能保证快照干净。

**预设要在两台机器上都装。** 会话里记录了 `agentPreset`（比如 `standard`、`unrestricted`）。如果还原后打开会话报 `agent-preset/not-found`，说明这台机器没装对应预设。工具在每次备份和还原结束时会打印需要的预设列表。

**还原会替换会话列表。** 现有会话会被移到 `$DSH_HOME` 下的 `.dsh-sync-trash-<时间戳>`，不会删除。确认没问题后手动删掉即可。

## 出问题了怎么办

先跑**体检** —— 它会检查日志可读性、父子会话完整性、附件在位情况、存储连通性。

| 现象 | 原因 | 解决 |
|---|---|---|
| 双击没反应 | 只拷了 exe | 整个文件夹一起发/解压 |
| 还原后看不到会话 | 工作目录路径不对 | 用正确路径重新还原 |
| `agent-preset/not-found` | 预设没装 | 装对应插件 |
| `corrupt session log` | 备份时 DSH 正在写 | 关掉 DSH 重新备份 |
| 存储连不上 | 路径不对 / 没登录 | 检查设置 |
| 「N 个附件在本机丢了」 | 源机器上被清理过 | 正常现象，显示为占位 |

## 项目结构

```
dsh-sync/
├── gui/
│   ├── main.cjs        Electron 主进程 —— 窗口、配置、IPC、任务
│   ├── preload.cjs     上下文隔离桥接（只暴露白名单 API）
│   ├── index.html      界面结构
│   ├── style.css       深色主题
│   ├── app.js          渲染进程逻辑
│   └── core.mjs        核心库 —— 扫描、备份、还原、改写
├── build/
│   ├── make-icon.mjs   零依赖生成 icon.ico
│   ├── pack.mjs        electron-packager 封装
│   ├── pack-zip.mjs    交付 zip
│   └── shot.ps1        截图自动化
├── dsh-sync.mjs        独立 CLI（复用同一套核心逻辑）
├── docs/screenshots/   README 配图
└── dist/               构建产物（已 gitignore）
```

`gui/core.mjs` 与 UI 无关 —— Electron 界面和 CLI 都 import 它。

## 环境要求

- Windows 10/11 x64（路径改写逻辑本身跨平台，只有打包是 Windows 专用）
- Node.js 22+（从源码构建时）
- DSH 会话格式 v4

## 许可证

MIT
