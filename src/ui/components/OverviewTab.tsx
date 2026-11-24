import React, { useState } from 'react';
import type {
  CallToolFn,
  ClaudeProjectResolution,
  OverviewPayload,
  UnifiedMemoryConfig,
} from '../types.js';

interface Props {
  overview: OverviewPayload;
  callTool: CallToolFn;
  onRefresh: () => Promise<void>;
  onSelectClaudeProject: (slug: string) => void;
  onSelectRulesWorkspace: (wsPath: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void;
}

function fmtBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function fmtTime(isoOrMs: string | number): string {
  if (!isoOrMs) return '—';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const OverviewTab: React.FC<Props> = ({
  overview,
  callTool,
  onRefresh,
  onSelectClaudeProject,
  onSelectRulesWorkspace,
  onNotify,
}) => {
  const [probePath, setProbePath] = useState(overview.workspaceHints[0] ?? '');
  const [resolution, setResolution] = useState<ClaudeProjectResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);

  const handleResolve = async () => {
    if (!probePath.trim()) return;
    setResolving(true);
    try {
      const res = await callTool<ClaudeProjectResolution>('ui_resolve_project', {
        inputPath: probePath.trim(),
      });
      setResolution(res);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setResolving(false);
    }
  };

  const updateCfg = async (patch: Partial<UnifiedMemoryConfig>) => {
    setSavingCfg(true);
    try {
      await callTool('ui_update_config', patch as Record<string, unknown>);
      await onRefresh();
      onNotify('Settings saved.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setSavingCfg(false);
    }
  };

  const handleClearDiagnostics = async () => {
    try {
      await callTool('ui_clear_diagnostics', {});
      await onRefresh();
      onNotify('Diagnostic log cleared.', 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    }
  };

  const activeCodexGen =
    overview.codex.activeGeneration === 'v2'
      ? overview.codex.v2
      : overview.codex.activeGeneration === 'v1'
        ? overview.codex.v1
        : null;

  return (
    <div>
      <div className="um-grid-2 um-section">
        <div className="um-card">
          <div className="um-card-header">
            <h3 className="um-card-title">Claude Code Memory</h3>
            <span className={`um-badge ${overview.claude.exists ? 'success' : 'warn'}`}>
              {overview.claude.exists ? 'Read-Write Ready' : 'Not Found'}
            </span>
          </div>
          <div className="um-kv">
            <span className="um-kv-key">Config Dir</span>
            <span className="um-mono">{overview.claude.configDir}</span>
            <span className="um-kv-key">Projects</span>
            <span>
              <strong>{overview.claude.projectCount}</strong> projects ·{' '}
              <strong>{overview.claude.totalTopics}</strong> topic notes
            </span>
            <span className="um-kv-key">Global Files</span>
            <span className="um-row">
              <span className={`um-badge ${overview.claude.hasGlobalClaudeMd ? 'info' : ''}`}>
                CLAUDE.md: {overview.claude.hasGlobalClaudeMd ? 'Yes' : 'No'}
              </span>
              <span className={`um-badge ${overview.claude.hasGlobalRulesDir ? 'info' : ''}`}>
                rules/: {overview.claude.hasGlobalRulesDir ? 'Yes' : 'No'}
              </span>
            </span>
            <span className="um-kv-key">Write Schema</span>
            <span className="um-mono">v2.1.x nested metadata</span>
          </div>
        </div>

        <div className="um-card">
          <div className="um-card-header">
            <h3 className="um-card-title">OpenAI Codex Memory</h3>
            <span className={`um-badge ${activeCodexGen ? 'info' : 'warn'}`}>
              {activeCodexGen ? `Read-Only (${overview.codex.activeGeneration})` : 'Not Found'}
            </span>
          </div>
          <div className="um-kv">
            <span className="um-kv-key">Codex Home</span>
            <span className="um-mono">{overview.codex.codexHome}</span>
            <span className="um-kv-key">Active Store</span>
            <span>
              {activeCodexGen ? (
                <>
                  <strong>{activeCodexGen.generation}</strong> · summary{' '}
                  {fmtBytes(activeCodexGen.summaryBytes)} ({activeCodexGen.summaryLines}L) ·{' '}
                  {activeCodexGen.rolloutCount} rollouts
                </>
              ) : (
                'No memories directory detected'
              )}
            </span>
            <span className="um-kv-key">Generations</span>
            <span className="um-row">
              <span className={`um-badge ${overview.codex.v2.exists ? 'success' : ''}`}>
                memories_v2: {overview.codex.v2.exists ? 'Yes' : 'No'}
              </span>
              <span className={`um-badge ${overview.codex.v1.exists ? 'info' : ''}`}>
                memories (v1): {overview.codex.v1.exists ? 'Yes' : 'No'}
              </span>
            </span>
            <span className="um-kv-key">Config Flags</span>
            <span className="um-mono">
              memories={String(overview.codex.configFlags.featuresMemories ?? 'unset')} · use=
              {String(overview.codex.configFlags.useMemories ?? 'unset')}
            </span>
          </div>
        </div>
      </div>

      <div className="um-card um-section">
        <div className="um-card-header">
          <h3 className="um-card-title">Project Slug &amp; Worktree Resolver</h3>
          <span className="um-muted">Verify exact Claude Code directory mapping</span>
        </div>
        <div className="um-row">
          <input
            className="um-input"
            style={{ flex: 1, minWidth: 200 }}
            value={probePath}
            onChange={(e) => setProbePath(e.target.value)}
            placeholder="/path/to/your/repository"
            list="um-workspace-hints"
          />
          <datalist id="um-workspace-hints">
            {overview.workspaceHints.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <button className="um-btn primary" onClick={handleResolve} disabled={resolving}>
            {resolving ? 'Resolving...' : 'Resolve'}
          </button>
        </div>

        {resolution && (
          <div className="um-item" style={{ marginTop: 10 }}>
            <div className="um-kv">
              <span className="um-kv-key">Main Repo Root</span>
              <span className="um-mono">
                {resolution.resolvedRoot}{' '}
                {resolution.isGitWorktree && (
                  <span className="um-badge info">Git Worktree → Main Repo</span>
                )}
              </span>
              <span className="um-kv-key">Encoded Slug</span>
              <span className="um-mono">{resolution.slug}</span>
              <span className="um-kv-key">Memory Dir</span>
              <span className="um-mono">
                {resolution.memoryDir}{' '}
                <span className={`um-badge ${resolution.exists ? 'success' : 'warn'}`}>
                  {resolution.exists ? 'Exists' : 'Will create on first save'}
                </span>
              </span>
            </div>
            <div className="um-row" style={{ marginTop: 8 }}>
              <button
                className="um-btn sm"
                onClick={() => onSelectClaudeProject(resolution.slug)}
              >
                Open in Claude Memory Tab
              </button>
              <button
                className="um-btn sm"
                onClick={() => onSelectRulesWorkspace(resolution.resolvedRoot)}
              >
                Inspect Rules for This Workspace
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="um-card um-section">
        <div className="um-card-header">
          <h3 className="um-card-title">Injection Settings</h3>
          <span className="um-muted">Persisted in PLUGIN_DATA/config.json</span>
        </div>

        <div className="um-toggle">
          <div>
            <div>Inject Codex Global Memory Summary on SessionStart</div>
            <div className="um-muted">
              Loads truncated read-only summary from memories_v2 (fallback memories).
            </div>
          </div>
          <input
            type="checkbox"
            checked={overview.config.injectCodexSummaryOnStart}
            disabled={savingCfg}
            onChange={(e) => updateCfg({ injectCodexSummaryOnStart: e.target.checked })}
          />
        </div>

        <div className="um-toggle">
          <div>
            <div>Codex Summary Startup Budget</div>
            <div className="um-muted">Caps global Codex summary size in SessionStart.</div>
          </div>
          <select
            className="um-select"
            style={{ width: 110 }}
            value={overview.config.codexSummaryMaxBytes}
            disabled={savingCfg}
            onChange={(e) => updateCfg({ codexSummaryMaxBytes: Number(e.target.value) })}
          >
            <option value={4096}>4 KB</option>
            <option value={8192}>8 KB</option>
            <option value={16384}>16 KB</option>
            <option value={32768}>32 KB</option>
          </select>
        </div>

        <div className="um-toggle">
          <div>
            <div>Deduplicate Native Workspace AGENTS.md / GEMINI.md</div>
            <div className="um-muted">
              Skips expanding @AGENTS.md imports already loaded natively by Antigravity.
            </div>
          </div>
          <input
            type="checkbox"
            checked={overview.config.deduplicateNativeAgentsMd}
            disabled={savingCfg}
            onChange={(e) => updateCfg({ deduplicateNativeAgentsMd: e.target.checked })}
          />
        </div>

        <div className="um-toggle">
          <div>
            <div>Also Inject Global ~/.codex/AGENTS.md (or AGENTS.override.md)</div>
            <div className="um-muted">Optional global Codex instructions on SessionStart.</div>
          </div>
          <input
            type="checkbox"
            checked={overview.config.injectCodexGlobalAgentsMd}
            disabled={savingCfg}
            onChange={(e) => updateCfg({ injectCodexGlobalAgentsMd: e.target.checked })}
          />
        </div>
      </div>

      <div className="um-card um-section">
        <div className="um-card-header">
          <h3 className="um-card-title">
            Recent Hook Activity ({overview.diagnostics.length})
          </h3>
          <div className="um-row">
            <button className="um-btn sm" onClick={onRefresh}>
              Refresh
            </button>
            <button
              className="um-btn sm"
              onClick={handleClearDiagnostics}
              disabled={overview.diagnostics.length === 0}
            >
              Clear Log
            </button>
          </div>
        </div>

        {overview.diagnostics.length === 0 ? (
          <div className="um-empty">
            No hook events recorded yet. Start a new conversation or read a file matching a
            scoped rule to see live injections here.
          </div>
        ) : (
          <div className="um-list">
            {overview.diagnostics.slice(0, 25).map((ev, idx) => (
              <div className="um-item" key={`${ev.ts}-${idx}`}>
                <div className="um-row-between">
                  <div className="um-row">
                    <span
                      className={`um-badge ${
                        ev.error
                          ? 'danger'
                          : ev.event === 'SessionStart'
                            ? 'success'
                            : ev.event === 'PreInvocation'
                              ? 'info'
                              : ''
                      }`}
                    >
                      {ev.event}
                    </span>
                    <span className="um-mono">{ev.elapsedMs.toFixed(1)} ms</span>
                    {ev.compactionReload && (
                      <span className="um-badge warn">Compaction Reload</span>
                    )}
                    {ev.hotReload && <span className="um-badge info">Hot Reload</span>}
                    {ev.toolName && <span className="um-badge">{ev.toolName}</span>}
                  </div>
                  <span className="um-muted">{fmtTime(ev.ts)}</span>
                </div>
                {ev.injectedLabels.length > 0 && (
                  <div className="um-row" style={{ marginTop: 6 }}>
                    {ev.injectedLabels.map((lbl, i) => (
                      <span className="um-badge" key={`${lbl}-${i}`}>
                        {lbl}
                      </span>
                    ))}
                  </div>
                )}
                {ev.error && (
                  <div className="um-mono" style={{ color: 'var(--um-danger-fg)', marginTop: 4 }}>
                    Error: {ev.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
