# CodeDock

把你的 VS Code 工作区变成一个 MCP (Model Context Protocol) 服务端:远程 AI 通过一条隧道连进来,即可安全地读写文件、执行命令、操作 git、调用 .NET / Godot 工具链。

> 当前版本 **1.6.5** · 39 个工具 · Windows / macOS / Linux

## 功能

- **文件工具**:读 / 写 / 搜索 / 目录列表 / 结构化补丁 (apply_patch)
- **执行工具**:run_command(带高危命令拦截弹窗)、后台进程管理
- **Git 工具**(10 个):status / diff / log / show / branch(Read 级),stage / commit / checkout(Edit 级),push / pull(Execute 级);全部 execFile 直调,无 shell 注入面;不提供 force push、hard reset 等毁灭性形态
- **工具链**:.NET(build / test / run / publish)、Godot(import / run / export)
- **Agent Skills**:自动发现工作区 `.claude/skills`、`.agents/skills`、`.github/skills`、`.codex/skills`、`.gemini/skills` 下的 SKILL.md,渐进式加载
- **MCP 聚合**:可将其他 stdio MCP server(`codedock.externalProviders` / 工作区 `.vscode/mcp.json`)聚合到同一入口,工具名自动加 `provider__` 前缀
- **隧道**:Cloudflare 快速隧道 / 命名隧道 / ngrok,面板一键启停、令牌重置

## 安全模型

- **三级权限**(读 / 编辑 / 执行)面板即时开关,按工具粒度映射
- **工作区边界**:所有路径解析后校验(含 symlink 真实路径复查);越界访问触发本机弹窗,可按会话逐目录放行,或在面板打开总开关放行全盘
- **高危命令守卫**:rm -rf、递归强删、磁盘级操作、git 强推等必须经本机弹窗确认,沉默即拒绝
- **工作区 MCP 聚合防提权**:`.vscode/mcp.json` 中的 server 仅在执行权限开启且命令行通过守卫扫描后才启动

## 安装

1. 从 [Releases](../../releases) 下载 `codedock-x.x.x.vsix`
2. `code --install-extension codedock-x.x.x.vsix`,重启 VS Code
3. 打开侧边栏 CodeDock 面板 → 启动 → 复制 MCP 地址给你的 AI 客户端

> 注:发布包内置 cloudflared / ngrok 二进制(约 84 MB,解包后)。若使用从源码打包的精简版,请自行安装 cloudflared 并在设置 `codedock.cloudflaredPath` 中填入完整路径。

## 开发与测试

纯 JavaScript,零运行时依赖(仅 vscode API)。

```bash
node test-fixes.js       # 51 项回归测试(修复项)
node test-git.js         # git 工具端到端(需本机 git)
node test-extraroots.js  # 越界授权流程
```

测试使用 `node_modules/vscode/` 下的最小 stub,无需真实 VS Code 环境。

## 版本历史

| 版本 | 内容 |
|---|---|
| 1.5.0 | 初始版本 |
| 1.5.1 | 修复 16 项审查问题(许可证激活、SSE 挂起、UTF-8 截断、Windows 引号注入面等) |
| 1.6.0 | 新增 10 个 git 工具 |
| 1.6.1 – 1.6.3 | 越界授权体系:会话级弹窗 + 面板全盘访问总开关 |
| 1.6.4 | 面板精简,越界弹窗简化 |
| 1.6.5 | Skills 兼容 `.claude/skills` 生态 |

## License

