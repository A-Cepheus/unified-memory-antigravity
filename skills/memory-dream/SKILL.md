---
name: memory-dream
description: >-
  Consolidate, deduplicate, prune stale entries, and keep Claude Code Auto Memory
  (MEMORY.md + topic files) healthy under the 200-line / 25 KB index budget —
  equivalent to Claude Code's Auto Dream maintenance pass. Use when the user asks
  to clean up, audit, consolidate, or dream-prune project memories.
---

# Memory Consolidation ("Auto Dream")

Run a structured hygiene pass over the current project's Claude Code Auto Memory (`~/.claude/projects/<slug>/memory/`). Never modify `~/.codex/` (strictly read-only).

## Steps

1. **Inventory Current State:**
   - Call `claude_memory_status` and `claude_memory_list` for the target workspace path.
   - Read `MEMORY.md` and inspect each topic file via `claude_memory_read`.
2. **Audit Against Live Reality:**
   - Check whether cited file paths, symbols, commands, or architectural constraints still exist in the current workspace.
   - Identify:
     * **Duplicates / overlapping topics** that should be merged into a single focused file.
     * **Contradictions** where newer feedback/decisions supersede older notes.
     * **Stale or derivable noise** (resolved temporary tasks, facts already written in `CLAUDE.md` or easily read from code).
     * **Index hygiene**: broken links in `MEMORY.md`, orphan topic files not listed in `MEMORY.md`, or `MEMORY.md` approaching 200 lines / 25 KB.
3. **Propose & Apply Safely:**
   - Summarize proposed merges, updates, and deletions clearly before destructive removals if any entry looks ambiguous; for unambiguous dead links/duplicates, apply via `claude_memory_save` and `claude_memory_delete`.
   - Ensure every surviving topic uses crisp descriptions (<= 150 chars in `MEMORY.md`) and valid `user` / `feedback` / `project` / `reference` categorization.
4. **Report Result:**
   - Re-run `claude_memory_status` and report before/after topic counts and `MEMORY.md` line/byte usage.
