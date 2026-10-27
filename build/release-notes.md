## DSH 会话同步 v1.0.0

把 DeepSeek Harness 的聊天记录在电脑之间搬来搬去。不用 git，不用命令行，不用云账号。

### 下载

**`DSH会话同步.zip`** — 147.7 MB，Windows x64，解压即用，不需要装 Node.js。

```
SHA-256: ea58cb58e9470638e2764052862ba68c27e6f5880cba8d6ae1afaad79e0a3dde
```

### 使用

1. 右键 → **全部解压**（不要直接在压缩包里双击）
2. 进入解压出来的文件夹
3. 双击 **`启动.cmd`**

> **为什么不能只拷 exe？**
> 这是 Electron 应用，`DSH_Sync.exe` 只是外壳，启动时要读同目录的
> `resources/app.asar`、`locales/` 和约 70 个 DLL/PAK 文件。
> 只拷 exe 出去，双击会瞬间退出、没有窗口。**必须整个文件夹一起用。**

### 功能

- **存储无关** — 本地文件夹、U 盘、OneDrive/坚果云同步目录、WebDAV、S3 兼容对象存储
- **路径改写** — 自动改写会话 header 里的 `cwd`，换机器不再报 `corrupt session log`
- **增量同步** — 按 SHA-256 判断，没变的会话直接跳过
- **附件去重** — 内容寻址，跟会话一起同步
- **父会话优先** — 子代理会话一定在父会话之后写入
- **不删东西** — 现有会话改名为 `.dsh-sync-trash-<时间戳>`

### 命令行版

不需要界面的话，直接用 `dsh-sync.mjs`：

```bash
node dsh-sync.mjs setup      # 交互式首次设置
node dsh-sync.mjs backup     # 备份
node dsh-sync.mjs restore    # 还原
node dsh-sync.mjs doctor     # 体检
```

### 注意

- 备份前建议关掉 DSH，保证快照干净
- 会话记录的 `agentPreset`（如 `standard`、`unrestricted`）需要在目标机器上也安装，否则打开会报 `agent-preset/not-found`
- 不同步 `.credentials.yaml`（API Key 留在本地）和 `profiles/*/cordis.patch.yml`（机器相关配置）

### 环境要求

- Windows 10/11 x64
- DSH 会话格式 v4

完整文档见 [README.zh-CN.md](https://github.com/xiaofang-code/dsh-sync/blob/main/README.zh-CN.md) / [README.md](https://github.com/xiaofang-code/dsh-sync/blob/main/README.md)
