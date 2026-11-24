import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  appendDiagnosticEvent,
  createEmptySessionState,
  detectCompaction,
  findSubdirectoryClaudeMdsWithDiagnostics,
  gcStaleSessions,
  getClaudeConfigDir,
  getCodexHome,
  loadClaudeRulesForWorkspaces,
  loadConditionalRuleContentWithDiagnostics,
  loadPluginConfig,
  loadSessionState,
  matchesGlobPatterns,
  readCodexGlobalAgentsMd,
  readCodexSummary,
  readMemoryIndex,
  resolveClaudeProject,
  resolvePluginDataDir,
  saveSessionState,
  type IndexedConditionalRule,
  type SessionState,
  type UnifiedMemoryConfig,
} from '../core/index.js';

interface HookStdinPayload {
  hookEventName?: string;
  conversationId?: string;
  workspacePaths?: string[];
  cwd?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  stepIdx?: number;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

/**
 * IMPORTANT (empirically proven in Phase 0 PoC):
 * Antigravity Desktop silently drops `injectSteps` when `systemMessage` carries
 * `metadata.user_markdown`. Always emit plain `{ systemMessage: { systemMessage } }`.
 */
function buildPlainSystemMessageOutput(text: string): {
  injectSteps: Array<{ systemMessage: { systemMessage: string } }>;
} {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text,
        },
      },
    ],
  };
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

function normalizeWorkspacePaths(payload: HookStdinPayload): string[] {
  const raw: string[] = [];
  if (Array.isArray(payload.workspacePaths)) {
    for (const p of payload.workspacePaths) {
      if (typeof p === 'string' && p.trim()) raw.push(path.resolve(p.trim()));
    }
  }
  if (raw.length === 0 && typeof payload.cwd === 'string' && payload.cwd.trim()) {
    raw.push(path.resolve(payload.cwd.trim()));
  }
  return Array.from(new Set(raw)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function clampUtf8(text: string, maxBytes: number): { content: string; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return { content: text, truncated: false };
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const b = Buffer.byteLength(lines[i], 'utf8') + (i > 0 ? 1 : 0);
    if (used + b > maxBytes) break;
    out.push(lines[i]);
    used += b;
  }
  return { content: out.join('\n'), truncated: true };
}

function formatPendingExternalNotice(pendingCount: number): string {
  return (
    `> [Unified Memory] Skipped ${pendingCount} unapproved external rule import(s)/symlink(s) outside this workspace. ` +
    `Open the Unified Memory dashboard (Rules & Context tab) to review and approve if trusted.`
  );
}

function buildBaselineInjection(
  workspacePaths: string[],
  config: UnifiedMemoryConfig,
  env: NodeJS.ProcessEnv,
  reason: 'session_start' | 'compaction_reload',
): {
  text: string;
  labels: string[];
  indexedConditionalRules: IndexedConditionalRule[];
  fileMtimes: Record<string, number>;
} {
  const claudeConfigDir = getClaudeConfigDir(env);
  const codexHome = getCodexHome(env);
  const rulesLoaded = loadClaudeRulesForWorkspaces(workspacePaths, {
    claudeConfigDir,
    deduplicateNativeAgentsMd: config.deduplicateNativeAgentsMd,
    trustClaudeCodeExternalApprovals: config.trustClaudeCodeExternalApprovals,
    externalRuleTrust: config.externalRuleTrust,
  });

  const sections: string[] = [];
  const labels: string[] = [];
  const fileMtimes: Record<string, number> = {};
  const indexedConditionalRules: IndexedConditionalRule[] = [];

  const headerTag =
    reason === 'compaction_reload'
      ? '[Unified Memory — Baseline Re-injected After Compaction]'
      : '[Unified Memory — Session Context (Claude Rules + Claude Auto Memory + Codex Read-Only)]';
  sections.push(headerTag);

  // 1. Global CLAUDE.md & unconditional ~/.claude/rules/
  if (rulesLoaded.globalAlwaysOn.length > 0) {
    const blocks: string[] = [];
    for (const r of rulesLoaded.globalAlwaysOn) {
      fileMtimes[r.filePath] = r.mtimeMs;
      labels.push(`${r.scope}:${r.displayPath}`);
      blocks.push(`### ${r.displayPath} (${r.scope})\n${r.content}`);
    }
    sections.push(`## Global Claude Instructions\n${blocks.join('\n\n')}`);
  }

  for (const gc of rulesLoaded.globalConditional) {
    for (const ws of workspacePaths) {
      indexedConditionalRules.push({
        id: `${gc.id}::${ws}`,
        filePath: gc.filePath,
        displayPath: gc.displayPath,
        workspaceRoot: ws,
        paths: gc.paths ?? [],
        scope: gc.scope,
      });
    }
  }

  // 2. Per-workspace CLAUDE.md, unconditional `.claude/rules/`, and Claude Auto Memory MEMORY.md
  const seenMemoryDirs = new Set<string>();
  for (const wsBundle of rulesLoaded.workspaces) {
    const wsName = path.basename(wsBundle.workspaceRoot) || wsBundle.workspaceRoot;
    const dormantConditionalFiles = new Set(wsBundle.conditional.map((c) => c.filePath));
    const pendingExternalCount = wsBundle.blockedExternalTargets.filter(
      (b) => b.status === 'pending_approval' && !dormantConditionalFiles.has(b.sourceFile),
    ).length;

    if (wsBundle.alwaysOn.length > 0 || pendingExternalCount > 0) {
      const blocks: string[] = [];
      for (const r of wsBundle.alwaysOn) {
        fileMtimes[r.filePath] = r.mtimeMs;
        labels.push(`${wsName}/${r.displayPath}`);
        blocks.push(`### ${r.displayPath} (${r.scope})\n${r.content}`);
      }
      if (pendingExternalCount > 0) {
        labels.push(`blocked-external:${wsName}:${pendingExternalCount}`);
        blocks.push(formatPendingExternalNotice(pendingExternalCount));
      }
      sections.push(
        `## Project Claude Instructions (${wsName} — ${wsBundle.workspaceRoot})\n${blocks.join('\n\n')}`,
      );
    }

    for (const cond of wsBundle.conditional) {
      indexedConditionalRules.push({
        id: cond.id,
        filePath: cond.filePath,
        displayPath: cond.displayPath,
        workspaceRoot: wsBundle.workspaceRoot,
        paths: cond.paths ?? [],
        scope: cond.scope,
      });
    }

    // Claude Auto Memory for this workspace
    const resolution = resolveClaudeProject(wsBundle.workspaceRoot, { claudeConfigDir, env });
    if (resolution.autoMemoryEnabled && !seenMemoryDirs.has(resolution.memoryDir)) {
      seenMemoryDirs.add(resolution.memoryDir);
      const memIndex = readMemoryIndex(resolution.memoryDir);
      if (memIndex.exists && memIndex.truncatedContent.trim()) {
        fileMtimes[memIndex.filePath] = memIndex.mtimeMs;
        labels.push(`claude-memory:${resolution.slug}`);
        const truncNote = memIndex.truncated
          ? `\n> [Truncated to ${memIndex.includedLines}/${memIndex.totalLines} lines, ${(memIndex.includedBytes / 1024).toFixed(1)}/${(memIndex.totalBytes / 1024).toFixed(1)} KB per Claude Code 200-line / 25 KB cap]`
          : '';
        sections.push(
          `## Claude Auto Memory Index (${wsName})\n` +
            `- Canonical memory dir: \`${resolution.memoryDir}\` (slug: \`${resolution.slug}\`${resolution.isGitWorktree ? ', resolved via Git main worktree' : ''})\n` +
            `- Use MCP tools \`claude_memory_read\` / \`claude_memory_save\` / \`claude_memory_delete\` to inspect or update topic files.\n\n` +
            `${memIndex.truncatedContent}${truncNote}`,
        );
      } else {
        sections.push(
          `## Claude Auto Memory (${wsName})\n` +
            `- Canonical memory dir: \`${resolution.memoryDir}\` (no MEMORY.md entries yet; use \`claude_memory_save\` when worth remembering).`,
        );
      }
    }
  }

  // 3. Codex Global Memory Summary (strictly read-only)
  if (config.injectCodexSummaryOnStart) {
    const codexSummary = readCodexSummary({
      codexHome,
      generation: 'auto',
      maxBytes: config.codexSummaryMaxBytes,
    });
    if (codexSummary.generation !== 'none' && codexSummary.content.trim()) {
      if (codexSummary.filePath) {
        fileMtimes[codexSummary.filePath] = codexSummary.mtimeMs;
      }
      labels.push(`codex-${codexSummary.generation}:memory_summary.md`);
      const truncNote = codexSummary.truncated
        ? `\n> [Codex global summary truncated to ${(config.codexSummaryMaxBytes / 1024).toFixed(1)} KB; use \`codex_memory_search\` / \`codex_memory_read\` for deeper details]`
        : '';
      sections.push(
        `## Codex Global Memory Summary (Read-Only, ${codexSummary.generation})\n` +
          `> Strictly read-only cross-repo summary from \`~/.codex\`. Never write to \`~/.codex/\`; use \`codex_memory_search\` for rollout summaries or extensions.\n\n` +
          `${codexSummary.content}${truncNote}`,
      );
    }
  }

  if (config.injectCodexGlobalAgentsMd) {
    const codexAgents = readCodexGlobalAgentsMd(codexHome);
    if (codexAgents && codexAgents.content) {
      labels.push(codexAgents.isOverride ? 'codex:AGENTS.override.md' : 'codex:AGENTS.md');
      sections.push(
        `## Codex Global Instructions (${codexAgents.isOverride ? 'AGENTS.override.md' : 'AGENTS.md'})\n${codexAgents.content}`,
      );
    }
  }

  if (sections.length <= 1) {
    return { text: '', labels: [], indexedConditionalRules, fileMtimes };
  }

  const joined = sections.join('\n\n---\n\n');
  const clamped = clampUtf8(joined, config.maxStartupInjectBytes);
  const finalText = clamped.truncated
    ? `${clamped.content}\n\n> [Unified Memory startup context truncated to ${(config.maxStartupInjectBytes / 1024).toFixed(0)} KB budget]`
    : clamped.content;

  return { text: finalText, labels, indexedConditionalRules, fileMtimes };
}

function handleSessionStart(
  payload: HookStdinPayload,
  dataDir: string,
  config: UnifiedMemoryConfig,
  t0: number,
): Record<string, unknown> {
  const convId = payload.conversationId || 'unknown';
  const workspacePaths = normalizeWorkspacePaths(payload);
  const existing = loadSessionState(convId, dataDir);

  // Idempotency guard: Antigravity can re-fire SessionStart on initial turn retry
  if (existing?.sessionStarted) {
    return {};
  }

  gcStaleSessions(dataDir);
  const baseline = buildBaselineInjection(workspacePaths, config, process.env, 'session_start');
  const state = existing ?? createEmptySessionState(convId, workspacePaths);
  state.sessionStarted = true;
  state.workspacePaths = workspacePaths;
  state.indexedConditionalRules = baseline.indexedConditionalRules;
  state.fileMtimes = baseline.fileMtimes;
  if (payload.transcriptPath && fs.existsSync(payload.transcriptPath)) {
    try {
      state.transcriptByteOffset = fs.statSync(payload.transcriptPath).size;
    } catch {
      // ignore
    }
  }
  saveSessionState(state, dataDir);

  const elapsedMs = Number((performance.now() - t0).toFixed(2));
  appendDiagnosticEvent(
    {
      ts: new Date().toISOString(),
      event: 'SessionStart',
      conversationId: convId,
      elapsedMs,
      workspacePaths,
      injectedCount: baseline.text ? 1 : 0,
      injectedLabels: baseline.labels,
    },
    dataDir,
  );

  return baseline.text ? buildPlainSystemMessageOutput(baseline.text) : {};
}

function handlePostToolUse(
  payload: HookStdinPayload,
  dataDir: string,
  config: UnifiedMemoryConfig,
  t0: number,
): Record<string, unknown> {
  const toolName = payload.toolCall?.name ?? '';
  const args = payload.toolCall?.args;
  const rawPath =
    args && typeof args === 'object' && typeof args.Path === 'string'
      ? args.Path.trim()
      : '';
  if (!rawPath) return {};

  const accessedPath = path.resolve(rawPath);
  const convId = payload.conversationId || 'unknown';
  const workspacePaths = normalizeWorkspacePaths(payload);
  let state = loadSessionState(convId, dataDir);

  if (!state) {
    // Conversation started before plugin was enabled: lazily index conditional rules now
    state = createEmptySessionState(convId, workspacePaths);
    const loaded = loadClaudeRulesForWorkspaces(workspacePaths, {
      claudeConfigDir: getClaudeConfigDir(process.env),
      deduplicateNativeAgentsMd: config.deduplicateNativeAgentsMd,
      trustClaudeCodeExternalApprovals: config.trustClaudeCodeExternalApprovals,
      externalRuleTrust: config.externalRuleTrust,
    });
    for (const wsBundle of loaded.workspaces) {
      for (const c of wsBundle.conditional) {
        state.indexedConditionalRules.push({
          id: c.id,
          filePath: c.filePath,
          displayPath: c.displayPath,
          workspaceRoot: wsBundle.workspaceRoot,
          paths: c.paths ?? [],
          scope: c.scope,
        });
      }
    }
    for (const gc of loaded.globalConditional) {
      for (const ws of workspacePaths) {
        state.indexedConditionalRules.push({
          id: `${gc.id}::${ws}`,
          filePath: gc.filePath,
          displayPath: gc.displayPath,
          workspaceRoot: ws,
          paths: gc.paths ?? [],
          scope: gc.scope,
        });
      }
    }
  } else if (workspacePaths.length > 0 && state.workspacePaths.length === 0) {
    state.workspacePaths = workspacePaths;
  }

  const effectiveWorkspaces =
    state.workspacePaths.length > 0 ? state.workspacePaths : workspacePaths;
  const loadedRuleSet = new Set(state.loadedRuleKeys);
  const loadedSubdirSet = new Set(state.loadedSubdirPaths);
  const pendingKeySet = new Set(state.pendingInjections.map((p) => p.key));
  const newlyQueuedLabels: string[] = [];

  // 1. Match path-scoped `.claude/rules/*.md`
  for (const rule of state.indexedConditionalRules) {
    if (loadedRuleSet.has(rule.id) || pendingKeySet.has(rule.id)) continue;
    const wsRoot = path.resolve(rule.workspaceRoot);
    if (accessedPath !== wsRoot && !accessedPath.startsWith(wsRoot + path.sep)) continue;

    const relPath = path.relative(wsRoot, accessedPath).replace(/\\/g, '/');
    if (matchesGlobPatterns(relPath, rule.paths)) {
      state.pendingInjections.push({
        key: rule.id,
        kind: 'scoped_rule',
        scope: rule.scope,
        filePath: rule.filePath,
        displayPath: rule.displayPath,
        workspaceRoot: wsRoot,
        triggeredBy: relPath,
        queuedAt: new Date().toISOString(),
      });
      pendingKeySet.add(rule.id);
      newlyQueuedLabels.push(`rule:${rule.displayPath}`);
    }
  }

  // 2. Discover unloaded subdirectory CLAUDE.md files
  for (const wsRoot of effectiveWorkspaces) {
    const absWs = path.resolve(wsRoot);
    if (accessedPath !== absWs && !accessedPath.startsWith(absWs + path.sep)) continue;
    const subResult = findSubdirectoryClaudeMdsWithDiagnostics(accessedPath, absWs, {
      claudeConfigDir: getClaudeConfigDir(process.env),
      deduplicateNativeAgentsMd: config.deduplicateNativeAgentsMd,
      trustClaudeCodeExternalApprovals: config.trustClaudeCodeExternalApprovals,
      externalRuleTrust: config.externalRuleTrust,
    });
    const relTriggered = path.relative(absWs, accessedPath).replace(/\\/g, '/');
    const queuedSubdirFiles = new Set<string>();
    for (const sub of subResult.entries) {
      queuedSubdirFiles.add(sub.filePath);
      if (loadedSubdirSet.has(sub.id) || pendingKeySet.has(sub.id)) continue;
      state.pendingInjections.push({
        key: sub.id,
        kind: 'subdir_claude_md',
        scope: 'subdir',
        filePath: sub.filePath,
        displayPath: sub.displayPath,
        workspaceRoot: absWs,
        triggeredBy: relTriggered,
        queuedAt: new Date().toISOString(),
      });
      pendingKeySet.add(sub.id);
      newlyQueuedLabels.push(`subdir:${sub.displayPath}`);
    }
    // Also queue a once-per-session notice if a subdir CLAUDE.md was completely blocked (e.g., symlink or import-only)
    for (const blk of subResult.blocked) {
      if (blk.status !== 'pending_approval') continue;
      if (queuedSubdirFiles.has(blk.sourceFile)) continue;
      const blockedKey = `blocked:${blk.sourceFile}`;
      if (loadedSubdirSet.has(blockedKey) || pendingKeySet.has(blockedKey)) continue;
      state.pendingInjections.push({
        key: blockedKey,
        kind: 'subdir_claude_md',
        scope: 'subdir',
        filePath: blk.sourceFile,
        displayPath: blk.sourceDisplayPath,
        workspaceRoot: absWs,
        triggeredBy: relTriggered,
        queuedAt: new Date().toISOString(),
      });
      pendingKeySet.add(blockedKey);
      newlyQueuedLabels.push(`blocked-subdir:${blk.sourceDisplayPath}`);
    }
  }

  if (newlyQueuedLabels.length > 0) {
    saveSessionState(state, dataDir);
    appendDiagnosticEvent(
      {
        ts: new Date().toISOString(),
        event: 'PostToolUse',
        conversationId: convId,
        elapsedMs: Number((performance.now() - t0).toFixed(2)),
        workspacePaths: effectiveWorkspaces,
        injectedCount: 0,
        injectedLabels: newlyQueuedLabels,
        toolName,
        triggeredBy: accessedPath,
      },
      dataDir,
    );
  }

  return {};
}

function handlePreInvocation(
  payload: HookStdinPayload,
  dataDir: string,
  config: UnifiedMemoryConfig,
  t0: number,
): Record<string, unknown> {
  const convId = payload.conversationId || 'unknown';
  const state = loadSessionState(convId, dataDir);
  if (!state) return {};

  const initialNumSteps =
    typeof payload.initialNumSteps === 'number' ? payload.initialNumSteps : null;
  const transcriptPath =
    typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()
      ? payload.transcriptPath.trim()
      : null;

  const prevOffset = state.transcriptByteOffset;
  const prevSteps = state.lastInitialNumSteps;
  const { compacted, newOffset } = detectCompaction(state, initialNumSteps, transcriptPath);
  state.transcriptByteOffset = newOffset;
  if (initialNumSteps !== null) {
    state.lastInitialNumSteps = initialNumSteps;
  }

  const parts: string[] = [];
  const labels: string[] = [];
  let compactionReload = false;
  let stateDirty = newOffset !== prevOffset || state.lastInitialNumSteps !== prevSteps;

  // 1. Re-inject fresh baseline ONLY after `/compact` (matches Claude Code & Codex:
  //    root CLAUDE.md / MEMORY.md / memory_summary.md stay frozen mid-session to
  //    avoid redundant uncached tokens and conflicting old+new copies in context).
  if (compacted && state.sessionStarted) {
    compactionReload = true;
    stateDirty = true;
    state.compactionCount += 1;
    const workspacePaths =
      state.workspacePaths.length > 0 ? state.workspacePaths : normalizeWorkspacePaths(payload);
    const baseline = buildBaselineInjection(
      workspacePaths,
      config,
      process.env,
      'compaction_reload',
    );
    state.indexedConditionalRules = baseline.indexedConditionalRules;
    state.fileMtimes = baseline.fileMtimes;
    state.loadedRuleKeys = [];
    state.loadedSubdirPaths = [];
    if (baseline.text) {
      parts.push(baseline.text);
      labels.push(...baseline.labels.map((l) => `compact:${l}`));
    }
  }

  // 2. Drain queued lazy-loaded path-scoped rules & subdirectory CLAUDE.md files
  if (state.pendingInjections.length > 0) {
    stateDirty = true;
    const loadedRules = new Set(state.loadedRuleKeys);
    const loadedSubdirs = new Set(state.loadedSubdirPaths);
    const lazyBlocks: string[] = [];

    for (const item of state.pendingInjections) {
      const trustLoadOpts = {
        claudeConfigDir: getClaudeConfigDir(process.env),
        deduplicateNativeAgentsMd: config.deduplicateNativeAgentsMd,
        trustClaudeCodeExternalApprovals: config.trustClaudeCodeExternalApprovals,
        externalRuleTrust: config.externalRuleTrust,
      };
      if (item.kind === 'scoped_rule') {
        if (loadedRules.has(item.key)) continue;
        const effectiveScope = item.scope ?? 'project_rule';
        const res = loadConditionalRuleContentWithDiagnostics(
          item.filePath,
          item.workspaceRoot,
          effectiveScope,
          trustLoadOpts,
        );
        loadedRules.add(item.key);
        const pendingCount = res.blocked.filter((b) => b.status === 'pending_approval').length;
        if (res.entry) {
          const note = pendingCount > 0 ? `\n\n${formatPendingExternalNotice(pendingCount)}` : '';
          lazyBlocks.push(
            `### ${item.displayPath} (path-scoped rule matched \`${item.triggeredBy}\`)\n${res.entry.content}${note}`,
          );
          labels.push(`lazy-rule:${item.displayPath}`);
        } else if (pendingCount > 0) {
          lazyBlocks.push(
            `### ${item.displayPath} (path-scoped rule matched \`${item.triggeredBy}\`)\n${formatPendingExternalNotice(pendingCount)}`,
          );
          labels.push(`lazy-blocked-rule:${item.displayPath}`);
        }
      } else {
        if (loadedSubdirs.has(item.key)) continue;
        const res = loadConditionalRuleContentWithDiagnostics(
          item.filePath,
          item.workspaceRoot,
          item.scope ?? 'subdir',
          trustLoadOpts,
        );
        loadedSubdirs.add(item.key);
        const pendingCount = res.blocked.filter((b) => b.status === 'pending_approval').length;
        if (res.entry) {
          const note = pendingCount > 0 ? `\n\n${formatPendingExternalNotice(pendingCount)}` : '';
          lazyBlocks.push(
            `### ${item.displayPath} (subdirectory CLAUDE.md triggered by \`${item.triggeredBy}\`)\n${res.entry.content}${note}`,
          );
          labels.push(`lazy-subdir:${item.displayPath}`);
        } else if (pendingCount > 0) {
          lazyBlocks.push(
            `### ${item.displayPath} (subdirectory CLAUDE.md triggered by \`${item.triggeredBy}\`)\n${formatPendingExternalNotice(pendingCount)}`,
          );
          labels.push(`lazy-blocked-subdir:${item.displayPath}`);
        }
      }
    }

    state.loadedRuleKeys = Array.from(loadedRules);
    state.loadedSubdirPaths = Array.from(loadedSubdirs);
    state.pendingInjections = [];

    if (lazyBlocks.length > 0) {
      parts.push(
        `[Unified Memory — Dynamically Loaded Scoped Rules]\n\n${lazyBlocks.join('\n\n---\n\n')}`,
      );
    }
  }

  if (stateDirty) {
    saveSessionState(state, dataDir);
  }

  if (parts.length === 0) {
    return {};
  }

  appendDiagnosticEvent(
    {
      ts: new Date().toISOString(),
      event: 'PreInvocation',
      conversationId: convId,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      workspacePaths: state.workspacePaths,
      injectedCount: 1,
      injectedLabels: labels,
      compactionReload,
    },
    dataDir,
  );

  return buildPlainSystemMessageOutput(parts.join('\n\n---\n\n'));
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const dataDir = resolvePluginDataDir(process.env);
  const config = loadPluginConfig(dataDir);

  const raw = await readStdinText();
  let payload: HookStdinPayload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as HookStdinPayload;
    } catch (err) {
      appendDiagnosticEvent(
        {
          ts: new Date().toISOString(),
          event: 'ParseError',
          conversationId: 'unknown',
          elapsedMs: Number((performance.now() - t0).toFixed(2)),
          workspacePaths: [],
          injectedCount: 0,
          injectedLabels: [],
          error: err instanceof Error ? err.message : String(err),
        },
        dataDir,
      );
      process.stdout.write('{}\n');
      return;
    }
  }

  const eventName = payload.hookEventName ?? '';
  let output: Record<string, unknown> = {};

  if (eventName === 'SessionStart') {
    output = handleSessionStart(payload, dataDir, config, t0);
  } else if (eventName === 'PostToolUse') {
    output = handlePostToolUse(payload, dataDir, config, t0);
  } else if (eventName === 'PreInvocation') {
    output = handlePreInvocation(payload, dataDir, config, t0);
  }

  process.stdout.write(JSON.stringify(output) + '\n');
}

main().catch((err) => {
  try {
    const dataDir = resolvePluginDataDir(process.env);
    appendDiagnosticEvent(
      {
        ts: new Date().toISOString(),
        event: 'UnhandledError',
        conversationId: 'unknown',
        elapsedMs: 0,
        workspacePaths: [],
        injectedCount: 0,
        injectedLabels: [],
        error: err instanceof Error ? err.message : String(err),
      },
      dataDir,
    );
  } catch {
    // ignore
  }
  process.stdout.write('{}\n');
});
