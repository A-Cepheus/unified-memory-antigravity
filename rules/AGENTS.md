# Unified Memory Standing Guidelines

This workspace uses **Unified Memory**, bridging **Claude Code Auto Memory** (read-write, aligned with Claude Code v2.1.x) and **OpenAI Codex CLI Memory** (strictly read-only), plus automatic loading of `CLAUDE.md` and `.claude/rules/`. Build up project memory over time so future sessions retain who the user is, how they collaborate, which approaches to repeat or avoid, and non-code context behind the work.

## 1. Using Loaded Memories & Verification
- Treat injected Claude Auto Memory (`MEMORY.md`), topic notes, and Codex Global Memory Summary as **historical snapshots, not infallible ground truth** ("the memory says X exists" != "X exists now").
- **Verify before acting or recommending:** confirm cited file paths still exist and check cited functions, flags, or commands against the current codebase. If a memory is outdated or contradicted by current code or user direction, trust live reality and update or remove the stale note via `claude_memory_save` / `claude_memory_delete`.
- Access memories whenever relevant or when the user asks to recall past work: call `claude_memory_read` for full detail behind `MEMORY.md` entries, and `codex_memory_search` (passing the current repository name as `projectHint`) / `codex_memory_read` for cross-session Codex context. If the user explicitly asks to ignore memories, treat them as absent. **Never attempt to write to `~/.codex/`.**

## 2. When to Save Claude Auto Memory (`claude_memory_save`)
- Save quietly as durable cross-session signals arise (no need to ask permission first), and act immediately when the user explicitly asks you to remember or forget something. **Skip saving on routine turns** where nothing non-obvious or lasting surfaced.
- Classify every saved topic strictly into Claude Code's 4 categories:
  1. **`user`** — User role, technical expertise, communication style, and recurring workflow/tooling preferences.
     - *When to save:* When you learn enduring details about how the user works or prefers responses tailored.
  2. **`feedback`** — Guidance on how to approach work: **record from failure AND success**.
     - *When to save:* When the user corrects your approach OR confirms a non-obvious/judgment-call choice. Saving only corrections avoids past mistakes but causes drift away from validated approaches and makes future sessions overly cautious.
     - *Body structure:* Lead with the concise rule, then add `**Why:**` (stated reason or underlying problem) and `**How to apply:**` (exact scope, triggers, or edge cases).
     - *Examples:*
       - Save (correction): "Don't mock the DB in integration tests — a previous mock/prod migration mismatch slipped past CI."
       - Save (validated): "User confirmed keeping the single bundled file without splitting chunks for zero-compile GitHub installs."
       - Skip: One-off typo fixes or standard coding advice already obvious from the codebase.
  3. **`project`** — Ongoing work context, architectural decisions, goals, incidents, or external deadlines not derivable from repository files or `git log`.
     - *When to save:* When the user explains *why* work or a constraint exists beyond the code itself. Convert relative dates ("next Thursday") into absolute ISO dates (`YYYY-MM-DD`).
     - *Body structure:* Lead with the fact or decision, then add `**Why:**` and `**How to apply:**` so future sessions can judge relevance as work evolves.
     - *Examples:*
       - Save: "Merge freeze begins 2026-12-01 for mobile release cut; defer non-critical refactors until after."
       - Skip: "Auth middleware lives in `src/auth/middleware.ts` and validates JWTs" (derivable from reading the repo).
  4. **`reference`** — Pointers to external systems outside the codebase (issue trackers, dashboards, deployment URLs, docs, channels) and what to look for there.

## 3. What NEVER to Save
- **Derivable code facts:** code patterns, architecture, file paths/layouts, or conventions directly readable from the repository or `package.json`.
- **Git history & debugging recipes:** who changed what, recent commits (`git log`), or bug-fix steps whose fix now lives in the code or commit history.
- **Duplicate standing rules:** anything already documented in `CLAUDE.md`, `AGENTS.md`, or `.claude/rules/`.
- **Ephemeral session state:** current-task plans, TODO checklists, in-progress debugging output, or one-off command results (do not use memory as a task scratchpad).
- **Secrets:** API keys, tokens, passwords, or private credentials.
- Even when the user says "remember X", distill the enduring constraint or non-obvious reason rather than dumping derivable code structure.

## 4. Writing Hygiene
- Always use `claude_memory_save` / `claude_memory_delete` rather than manually editing files under `~/.claude/projects/*/memory/` — the MCP tools enforce Claude Code v2.1.x nested `metadata:` frontmatter, cross-process file locking, atomic writes, and `MEMORY.md` 200-line / 25 KB index synchronization.
- Before creating a new topic file, call `claude_memory_list` to check for existing topics on the same subject — **update or merge in place** rather than creating duplicates or contradictions.
- Write a specific, crisp `description` (<= 150 chars) so future sessions can accurately decide whether to open the topic file from `MEMORY.md`.
- If the user asks to view or manage memories visually, call `open_memory_dashboard` to open the Unified Memory UI panel.
