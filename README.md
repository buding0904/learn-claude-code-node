# learn-claude-code-node

Node.js + TypeScript 版本的 [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 实现，原版使用 Python，本仓库用 TypeScript 重写，使用 [Bun](https://bun.sh) 运行。

## 环境准备

```bash
# 安装 bun
curl -fsSL https://bun.sh/install | bash

# 安装依赖
bun install

# 配置环境变量
cp .env.sample .env
# 编辑 .env，填写以下配置：
# API_KEY=你的 API Key
# BASE_URL=API 服务地址（默认为豆包 API）
# MODEL_NAME=模型名称
```

## 运行

```bash
bun run agents/s01-the-agent-loop.ts
```

or

```bash
bun run s01
```

## 调试

设置环境变量 `DEBUG_MESSAGES=true` 后，程序退出时会将完整的对话历史保存到当前目录，文件名格式为 `chat-MMdd-hhmmss.json`：

```bash
DEBUG_MESSAGES=true bun run s01
```

- [x] [s01](./agents/s01-the-agent-loop.ts) — The Agent Loop: _One loop & Bash is all you need_
- [x] [s02](./agents/s02-tool-use.ts) — Tool Use: _Adding a tool means adding one handler_
- [x] [s03](./agents/s03-todo-write.ts) — TodoWrite: _An agent without a plan drifts_
- [x] [s04](./agents/s04-subagent.ts) — Subagents: _Break big tasks down; each subtask gets a clean context_
- [x] [s05](./agents/s05-skill-loading.ts) — Skills: _Load knowledge when you need it, not upfront_
- [x] [s06](./agents/s06-context-compact.ts) — Context Compact: _Context will fill up; you need a way to make room_
- [ ] s07 — Tasks: _Break big goals into small tasks, order them, persist to disk_
- [ ] s08 — Background Tasks: _Run slow operations in the background; the agent keeps thinking_
- [ ] s09 — Agent Teams: _When the task is too big for one, delegate to teammates_
- [ ] s10 — Team Protocols: _Teammates need shared communication rules_
- [ ] s11 — Autonomous Agents: _Teammates scan the board and claim tasks themselves_
- [ ] s12 — Worktree + Task Isolation: _Each works in its own directory, no interference_
