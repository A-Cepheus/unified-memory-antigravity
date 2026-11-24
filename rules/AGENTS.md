# Unified Memory Standing Guidelines

This workspace uses **Unified Memory**, bridging **Claude Code Auto Memory** (read-write, aligned with Claude Code v2.1.x) and **OpenAI Codex CLI Memory** (strictly read-only), plus automatic loading of `CLAUDE.md` and `.claude/rules/`.

## 1. How to Use Loaded Memories
- Treat injected Claude Auto Memory (`MEMORY.md`), topic notes, and Codex Global Memory Summary as **historical context, not infallible ground truth**.
- Before acting on a memory that cites specific files, functions, flags, or behaviors, verify against the current codebase first. If a memory is outdated or contradicted by current code, update or delete it with the Claude memory tools.
- When you need deeper detail behind an entry in `MEMORY.md`, call `claude_memory_read`.
- When you want past cross-session lessons from Codex (e.g., rollout summaries or `extensions/ad_hoc` notes), call `codex_memory_search` (passing the current repository name as `projectHint`) and `codex_memory_read`. **Never attempt to write to `~/.codex/`.**

## 2. When to Save Claude Auto Memory (`claude_memory_save`)
Align strictly with Claude Code's 4-category memory discipline:
1. **`user`** — User role, technical expertise, communication style, recurring tooling preferences.
2. **`feedback`** — Explicit user corrections, constraints, or confirmed approaches ("don't mock the DB in integration tests", "always keep backward compatibility with v1"). Include **why** and **when to apply**.
3. **`project`** — Ongoing work context, architectural decisions, goals, or external deadlines that cannot be deduced from the repository or `git log`. Convert relative dates ("next Thursday") into absolute ISO dates.
4. **`reference`** — Pointers to external systems outside the codebase (issue trackers, dashboards, deployment URLs, docs).

## 3. What NEVER to Save
- Facts directly derivable from reading the repository, `package.json`, `git log`, or code structure.
- Temporary debugging state, one-off command outputs, or rules already documented in `CLAUDE.md` / `AGENTS.md`.
- Secrets, tokens, passwords, or API keys.

## 4. Writing Hygiene
- Always use `claude_memory_save` / `claude_memory_delete` rather than manually editing files under `~/.claude/projects/*/memory/` — the MCP tools enforce Claude Code v2.1.x nested `metadata:` frontmatter, cross-process file locking, atomic writes, and `MEMORY.md` 200-line / 25 KB index synchronization.
- Before creating a duplicate topic file, call `claude_memory_list` to check if an existing topic should be updated instead.
- If the user asks to view or manage memories visually, call `open_memory_dashboard` to open the Unified Memory UI panel.
