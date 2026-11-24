import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  type DiagnosticEvent,
  type SessionState,
  type UnifiedMemoryConfig,
  type WorkspaceExternalTrustConfig,
} from '../types.js';
import { atomicWriteFile } from '../claude/memory.js';
import { canonicalizeFsPath } from '../claude/paths.js';

const MAX_DIAGNOSTIC_LINES = 300;
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function resolvePluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const preferred =
    env.PLUGIN_DATA?.trim() ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'unified-memory-antigravity');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'unified-memory-antigravity');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function sanitizePathArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const cleaned = item.trim();
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function sanitizeExternalRuleTrust(
  input: unknown,
): Record<string, WorkspaceExternalTrustConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: Record<string, WorkspaceExternalTrustConfig> = {};
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    if (!rawKey.trim() || !rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) {
      continue;
    }
    const rec = rawVal as Record<string, unknown>;
    const allowPaths = sanitizePathArray(rec.allowPaths);
    const denyPaths = sanitizePathArray(rec.denyPaths);
    if (allowPaths.length > 0 || denyPaths.length > 0) {
      result[rawKey.trim()] = { allowPaths, denyPaths };
    }
  }
  return result;
}

export function loadPluginConfig(dataDir: string = resolvePluginDataDir()): UnifiedMemoryConfig {
  const cfgPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    return { ...DEFAULT_CONFIG, externalRuleTrust: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<UnifiedMemoryConfig>;
    return {
      injectCodexSummaryOnStart:
        typeof raw.injectCodexSummaryOnStart === 'boolean'
          ? raw.injectCodexSummaryOnStart
          : DEFAULT_CONFIG.injectCodexSummaryOnStart,
      codexSummaryMaxBytes:
        typeof raw.codexSummaryMaxBytes === 'number' && raw.codexSummaryMaxBytes >= 512
          ? raw.codexSummaryMaxBytes
          : DEFAULT_CONFIG.codexSummaryMaxBytes,
      injectCodexGlobalAgentsMd:
        typeof raw.injectCodexGlobalAgentsMd === 'boolean'
          ? raw.injectCodexGlobalAgentsMd
          : DEFAULT_CONFIG.injectCodexGlobalAgentsMd,
      deduplicateNativeAgentsMd:
        typeof raw.deduplicateNativeAgentsMd === 'boolean'
          ? raw.deduplicateNativeAgentsMd
          : DEFAULT_CONFIG.deduplicateNativeAgentsMd,
      maxStartupInjectBytes:
        typeof raw.maxStartupInjectBytes === 'number' && raw.maxStartupInjectBytes >= 4096
          ? raw.maxStartupInjectBytes
          : DEFAULT_CONFIG.maxStartupInjectBytes,
      trustClaudeCodeExternalApprovals:
        typeof raw.trustClaudeCodeExternalApprovals === 'boolean'
          ? raw.trustClaudeCodeExternalApprovals
          : DEFAULT_CONFIG.trustClaudeCodeExternalApprovals,
      externalRuleTrust: sanitizeExternalRuleTrust(raw.externalRuleTrust),
    };
  } catch {
    return { ...DEFAULT_CONFIG, externalRuleTrust: {} };
  }
}

export function savePluginConfig(
  patch: Partial<UnifiedMemoryConfig>,
  dataDir: string = resolvePluginDataDir(),
): UnifiedMemoryConfig {
  const current = loadPluginConfig(dataDir);
  const next: UnifiedMemoryConfig = {
    ...current,
    ...patch,
    externalRuleTrust:
      patch.externalRuleTrust !== undefined
        ? sanitizeExternalRuleTrust(patch.externalRuleTrust)
        : current.externalRuleTrust,
  };
  atomicWriteFile(path.join(dataDir, 'config.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function getWorkspaceExternalTrust(
  externalRuleTrust: Record<string, WorkspaceExternalTrustConfig> | undefined,
  workspaceRoot: string,
): WorkspaceExternalTrustConfig {
  if (!externalRuleTrust) return { allowPaths: [], denyPaths: [] };
  const resolvedWs = path.resolve(workspaceRoot);
  const realWs = canonicalizeFsPath(workspaceRoot);
  const allowSet = new Set<string>();
  const denySet = new Set<string>();

  for (const [key, entry] of Object.entries(externalRuleTrust)) {
    const normKey = path.resolve(key);
    if (normKey === resolvedWs || normKey === realWs || canonicalizeFsPath(normKey) === realWs) {
      for (const p of entry.allowPaths) allowSet.add(canonicalizeFsPath(p));
      for (const p of entry.denyPaths) denySet.add(canonicalizeFsPath(p));
    }
  }

  return {
    allowPaths: Array.from(allowSet).sort(),
    denyPaths: Array.from(denySet).sort(),
  };
}

export type ExternalTrustAction = 'allow' | 'deny' | 'revoke' | 'clear_workspace';

export function updateWorkspaceExternalTrust(
  workspaceRoot: string,
  action: ExternalTrustAction,
  targetPath?: string,
  dataDir: string = resolvePluginDataDir(),
): {
  config: UnifiedMemoryConfig;
  workspaceKey: string;
  trust: WorkspaceExternalTrustConfig;
} {
  const config = loadPluginConfig(dataDir);
  const wsKey = canonicalizeFsPath(workspaceRoot);
  const resolvedWs = path.resolve(workspaceRoot);

  // Merge any alias keys for this workspace under canonical wsKey
  const existing = getWorkspaceExternalTrust(config.externalRuleTrust, workspaceRoot);
  const nextMap: Record<string, WorkspaceExternalTrustConfig> = {};
  for (const [k, v] of Object.entries(config.externalRuleTrust)) {
    const nk = path.resolve(k);
    if (nk === resolvedWs || nk === wsKey || canonicalizeFsPath(nk) === wsKey) continue;
    nextMap[k] = v;
  }

  if (action === 'clear_workspace') {
    const saved = savePluginConfig({ externalRuleTrust: nextMap }, dataDir);
    return { config: saved, workspaceKey: wsKey, trust: { allowPaths: [], denyPaths: [] } };
  }

  if (!targetPath || !targetPath.trim()) {
    throw new Error(`targetPath is required for action "${action}"`);
  }

  const canonicalTarget = canonicalizeFsPath(targetPath);
  const allowSet = new Set(existing.allowPaths);
  const denySet = new Set(existing.denyPaths);

  if (action === 'allow') {
    allowSet.add(canonicalTarget);
    denySet.delete(canonicalTarget);
  } else if (action === 'deny') {
    denySet.add(canonicalTarget);
    allowSet.delete(canonicalTarget);
  } else if (action === 'revoke') {
    allowSet.delete(canonicalTarget);
    denySet.delete(canonicalTarget);
  }

  const nextTrust: WorkspaceExternalTrustConfig = {
    allowPaths: Array.from(allowSet).sort(),
    denyPaths: Array.from(denySet).sort(),
  };
  if (nextTrust.allowPaths.length > 0 || nextTrust.denyPaths.length > 0) {
    nextMap[wsKey] = nextTrust;
  }

  const saved = savePluginConfig({ externalRuleTrust: nextMap }, dataDir);
  return { config: saved, workspaceKey: wsKey, trust: nextTrust };
}

function safeConversationKey(conversationId: string): string {
  return String(conversationId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sessionsDir(dataDir: string): string {
  const dir = path.join(dataDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createEmptySessionState(
  conversationId: string,
  workspacePaths: string[] = [],
): SessionState {
  const now = new Date().toISOString();
  return {
    conversationId,
    sessionStarted: false,
    startedAt: now,
    workspacePaths,
    loadedRuleKeys: [],
    loadedSubdirPaths: [],
    indexedConditionalRules: [],
    pendingInjections: [],
    fileMtimes: {},
    lastInitialNumSteps: 0,
    transcriptByteOffset: 0,
    compactionCount: 0,
    updatedAt: now,
  };
}

export function loadSessionState(
  conversationId: string,
  dataDir: string = resolvePluginDataDir(),
): SessionState | null {
  const filePath = path.join(sessionsDir(dataDir), `${safeConversationKey(conversationId)}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

export function saveSessionState(
  state: SessionState,
  dataDir: string = resolvePluginDataDir(),
): void {
  state.updatedAt = new Date().toISOString();
  const filePath = path.join(
    sessionsDir(dataDir),
    `${safeConversationKey(state.conversationId)}.json`,
  );
  atomicWriteFile(filePath, JSON.stringify(state, null, 2) + '\n');
}

export function listRecentSessions(
  dataDir: string = resolvePluginDataDir(),
  limit: number = 20,
): SessionState[] {
  const dir = sessionsDir(dataDir);
  const results: SessionState[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try {
        results.push(JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')) as SessionState);
      } catch {
        // ignore corrupt session file
      }
    }
  } catch {
    return [];
  }
  results.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return results.slice(0, limit);
}

export function gcStaleSessions(dataDir: string = resolvePluginDataDir()): void {
  const dir = sessionsDir(dataDir);
  const cutoff = Date.now() - STALE_SESSION_MS;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const full = path.join(dir, e.name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Checks whether a compaction event occurred since the last PreInvocation call
 * by detecting either a drop in `initialNumSteps` or a compaction marker in
 * the newly appended bytes of `transcript_full.jsonl`.
 */
export function detectCompaction(
  state: SessionState,
  initialNumSteps: number | null,
  transcriptPath: string | null,
): { compacted: boolean; newOffset: number } {
  let compacted = false;
  let newOffset = state.transcriptByteOffset;

  if (
    typeof initialNumSteps === 'number' &&
    state.lastInitialNumSteps > 0 &&
    initialNumSteps < state.lastInitialNumSteps
  ) {
    compacted = true;
  }

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const st = fs.statSync(transcriptPath);
      if (st.size < state.transcriptByteOffset) {
        // Transcript file shrank/rewritten
        compacted = true;
        newOffset = st.size;
      } else if (st.size > state.transcriptByteOffset) {
        const toRead = Math.min(st.size - state.transcriptByteOffset, 256 * 1024);
        const startPos = st.size - toRead;
        const fd = fs.openSync(transcriptPath, 'r');
        try {
          const buf = Buffer.alloc(toRead);
          fs.readSync(fd, buf, 0, toRead, startPos);
          const chunk = buf.toString('utf8');
          for (const line of chunk.split('\n')) {
            if (!line.trim()) continue;
            // Detect compaction step markers in JSONL without expensive full parsing
            if (
              /"type"\s*:\s*"[^"]*COMPACT[^"]*"/i.test(line) ||
              /"type"\s*:\s*"CONVERSATION_SUMMARY"/i.test(line) ||
              /"type"\s*:\s*"CHECKPOINT"/i.test(line)
            ) {
              compacted = true;
              break;
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        newOffset = st.size;
      }
    } catch {
      // ignore transcript read failure
    }
  }

  return { compacted, newOffset };
}

export function appendDiagnosticEvent(
  event: DiagnosticEvent,
  dataDir: string = resolvePluginDataDir(),
): void {
  const logPath = path.join(dataDir, 'diagnostics.jsonl');
  try {
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
    // Trim ring buffer when over 400KB
    const st = fs.statSync(logPath);
    if (st.size > 400 * 1024) {
      const lines = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      const trimmed = lines.slice(-MAX_DIAGNOSTIC_LINES).join('\n') + '\n';
      atomicWriteFile(logPath, trimmed);
    }
  } catch {
    // never fail a hook due to diagnostic logging
  }
}

export function readDiagnosticEvents(
  dataDir: string = resolvePluginDataDir(),
  limit: number = 100,
): DiagnosticEvent[] {
  const logPath = path.join(dataDir, 'diagnostics.jsonl');
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const slice = lines.slice(-limit).reverse();
    const events: DiagnosticEvent[] = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line) as DiagnosticEvent);
      } catch {
        // ignore bad line
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function clearDiagnosticEvents(dataDir: string = resolvePluginDataDir()): void {
  const logPath = path.join(dataDir, 'diagnostics.jsonl');
  if (fs.existsSync(logPath)) {
    atomicWriteFile(logPath, '');
  }
}
