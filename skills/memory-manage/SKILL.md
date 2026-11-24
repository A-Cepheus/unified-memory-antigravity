---
name: memory-manage
description: >-
  Inspect, search, diagnose, edit, or clean up Claude Code Auto Memory, CLAUDE.md
  / .claude/rules loading, and read-only Codex CLI memories. Use when the user
  asks to view memory status (like Claude Code's /memory command), debug why a
  rule or memory file did or did not load, or open the Unified Memory dashboard.
---

# Manage Unified Memory

Use this skill to inspect and manage the user's cross-ecosystem memories and loaded rules.

## Workflow

1. **Interactive Dashboard (Preferred in Antigravity Desktop):**
   - Call `open_memory_dashboard` on the `unified-memory-antigravity_memory` MCP server so the user gets the full visual panel (Overview, Claude Memory editor, Codex Read-Only explorer, Rules inspector).
2. **Diagnostic Status Check:**
   - Call `claude_memory_status` with the active workspace root to verify Git worktree resolution, project slug encoding, `memoryDir` path, and `MEMORY.md` line/byte budget (vs 200 lines / 25 KB).
   - Call `claude_rules_inspect` with the active workspace root to show every loaded `CLAUDE.md`, `@import` expansion, native `AGENTS.md` dedup, and `.claude/rules/` (always-on vs `paths:` glob rules).
   - Call `codex_memory_summary` to confirm active Codex generation (`memories_v2` vs `memories`) and read-only availability.
3. **Editing / Searching:**
   - Use `claude_memory_list`, `claude_memory_read`, `claude_memory_save`, `claude_memory_delete` for Claude Code Auto Memory (v2.1.x nested `metadata:` format).
   - Use `codex_memory_search` and `codex_memory_read` for read-only Codex lookups. Never modify anything under `~/.codex/`.
