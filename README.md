# Unified Memory for Antigravity (`unified-memory-antigravity`)

An **Antigravity Desktop / CLI plugin** that bridges:

- **Claude Code Auto Memory (Read-Write, v2.1.x aligned)**: exact project slug encoding (`[^a-zA-Z0-9] → -`, >200-char hash suffix, Git worktree main-repo resolution), `MEMORY.md` 200-line / 25 KB startup cap, dual-schema frontmatter reader (legacy flat + latest nested `metadata: { node_type: memory, type, originSessionId, modified }`), cross-process lockfile + atomic writes.
- **`CLAUDE.md` & `.claude/rules/` (Claude Code parity)**: Managed → User → Ancestor → Project → `CLAUDE.local.md` hierarchy across Antigravity multi-root `workspacePaths`, `@import` expansion (up to 5 hops, cycle detection, code-block skipping, native `AGENTS.md` deduplication), HTML comment stripping, `claudeMdExcludes`, plus `PostToolUse → PreInvocation` two-stage lazy loading for path-scoped `.claude/rules/` (`paths:` globs) and subdirectory `CLAUDE.md` files, and `/compact` auto re-injection.
- **OpenAI Codex CLI Memory (Strictly Read-Only)**: prefers `~/.codex/memories_v2/` with fallback to `~/.codex/memories/`, strips leading `v1` version header, supports `extensions/ad_hoc/`, `rollout_summaries/`, `skills/`, and chunked v1 `MEMORY.md` search — zero writes to `~/.codex/`.
- **Native Antigravity Desktop Frontend UI (MCP App)**: appears directly in the **left sidebar (`global`)** and **side pane `+` menu (`aux_pane`)** with automatic light/dark theme sync.

---

## Install (Zero-Compile, Cross-Platform)

Pre-bundled single-file artifacts (`dist/hook.cjs`, `dist/mcp.cjs`, `dist/app.html`) are committed so installation requires **only Node.js 20+** and zero compilation:

```bash
# Option 1: Install via Antigravity CLI from GitHub
agy plugin install https://github.com/A-Cepheus/unified-memory-antigravity

# Option 2: Symlink local checkout into Antigravity global plugins
ln -s "$(pwd)" ~/.gemini/config/plugins/unified-memory-antigravity
```

Antigravity automatically discovers the plugin without requiring a restart. Open **Unified Memory** from the left sidebar or the side pane `+` menu.

---

## Architecture

```text
unified-memory-antigravity/
├── plugin.json             # Antigravity plugin manifest
├── hooks.json              # SessionStart / PostToolUse (file tools) / PreInvocation
├── mcp_config.json         # Stdio MCP server (`${PLUGIN_ROOT}/dist/mcp.cjs`)
├── rules/AGENTS.md         # Standing guidelines aligned with Claude Code's 4 memory types
├── skills/
│   ├── memory-manage/      # Interactive status & inspection workflow (like /memory)
│   └── memory-dream/       # Consolidation & stale-entry cleanup workflow (like Auto Dream)
├── src/
│   ├── core/               # Host-agnostic engine (reusable for Codex / Claude / DeepSeek adapters)
│   ├── hook/               # Antigravity Hook CLI
│   ├── mcp/                # Stdio MCP Server + MCP App resource & app-only UI endpoints
│   └── ui/                 # React + @modelcontextprotocol/ext-apps single-file Desktop UI
└── dist/                   # Pre-bundled zero-dependency runtime files
    ├── hook.cjs
    ├── mcp.cjs
    └── app.html
```

---

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

For fast UI iteration inside Antigravity Desktop, set `UNIFIED_MEMORY_APP_HTML` in the MCP server env to point to your built `dist/app.html` and call `RefreshMcpServers` or restart the server in MCP settings.
