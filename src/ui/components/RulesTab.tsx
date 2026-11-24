import React, { useEffect, useState } from 'react';
import type {
  ApprovedExternalRuleTarget,
  BlockedExternalRuleTarget,
  CallToolFn,
  ClaudeRuleEntry,
  RulesInspectPayload,
} from '../types.js';

interface Props {
  workspaceHints: string[];
  selectedWorkspace: string;
  onSelectWorkspace: (ws: string) => void;
  callTool: CallToolFn;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void;
}

function getSafeParentDir(targetPath: string): string | null {
  const normalized = targetPath.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (idx <= 0) return null;
  const parent = normalized.slice(0, idx);
  // Avoid offering 1-click approval of filesystem root or immediate home root (/Users/<name>, /home/<name>, C:\Users\<name>)
  const segments = parent.split(/[\\/]/).filter(Boolean);
  if (
    (segments.length <= 2 && (segments[0] === 'Users' || segments[0] === 'home')) ||
    (segments.length <= 3 && /^[A-Za-z]:$/.test(segments[0]) && segments[1] === 'Users')
  ) {
    return null;
  }
  return parent;
}

function formatKindLabel(kind: BlockedExternalRuleTarget['kind']): string {
  if (kind === 'external_import') return '@import';
  if (kind === 'external_rule_dir_symlink') return 'dir symlink';
  return 'rule symlink';
}

function formatBlockStatusLabel(status: BlockedExternalRuleTarget['status']): string {
  if (status === 'denied_by_plugin') return 'dismissed';
  if (status === 'denied_by_claude_code') return 'declined in Claude Code';
  return 'pending approval';
}

function formatApprovalSourceLabel(source: ApprovedExternalRuleTarget['approvedBy']): string {
  if (source === 'claude_code_project_approval') return 'Claude Code (~/.claude.json)';
  if (source === 'plugin_dir_allowlist') return 'allowed dir';
  return 'allowed file';
}

export const RulesTab: React.FC<Props> = ({
  workspaceHints,
  selectedWorkspace,
  onSelectWorkspace,
  callTool,
  onNotify,
}) => {
  const [inputPath, setInputPath] = useState(selectedWorkspace || workspaceHints[0] || '');
  const [manualTrustPath, setManualTrustPath] = useState('');
  const [data, setData] = useState<RulesInspectPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingTrust, setSavingTrust] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const inspect = async (wsPath: string) => {
    setLoading(true);
    try {
      const res = await callTool<RulesInspectPayload>('ui_inspect_rules', {
        workspacePath: wsPath.trim() || undefined,
      });
      setData(res);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setLoading(false);
    }
  };

  const updateExternalTrust = async (
    workspacePath: string,
    action: 'allow' | 'deny' | 'revoke' | 'clear_workspace',
    targetPath?: string,
  ) => {
    setSavingTrust(true);
    try {
      await callTool('ui_update_external_trust', {
        workspacePath,
        action,
        ...(targetPath ? { targetPath } : {}),
      });
      await inspect(workspacePath);
      const msg =
        action === 'allow'
          ? 'Approved external target. Takes effect on next session or /compact.'
          : action === 'deny'
            ? 'Denied external target. Suppressed from startup notices.'
            : 'Updated workspace external rule trust.';
      onNotify(msg, action === 'allow' ? 'success' : 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setSavingTrust(false);
    }
  };

  useEffect(() => {
    const target = selectedWorkspace || workspaceHints[0] || '';
    setInputPath(target);
    inspect(target);
  }, [selectedWorkspace]);

  const renderRuleCard = (rule: ClaudeRuleEntry) => {
    const isExpanded = expandedId === rule.id;
    return (
      <div className="um-item" key={rule.id}>
        <div className="um-row-between">
          <div className="um-row">
            <span className={`um-badge ${rule.isConditional ? 'warn' : 'success'}`}>
              {rule.isConditional ? 'path-scoped' : 'always-on'}
            </span>
            <span className="um-badge info">{rule.scope}</span>
            <span className="um-mono">{rule.displayPath}</span>
          </div>
          <div className="um-row">
            <span className="um-muted">{rule.sizeBytes} B</span>
            <button
              className="um-btn sm"
              onClick={() => setExpandedId(isExpanded ? null : rule.id)}
            >
              {isExpanded ? 'Hide' : 'Preview'}
            </button>
          </div>
        </div>

        {rule.paths && rule.paths.length > 0 && (
          <div className="um-row" style={{ marginTop: 6 }}>
            <span className="um-muted">paths:</span>
            {rule.paths.map((p) => (
              <span className="um-badge um-mono" key={p}>
                {p}
              </span>
            ))}
          </div>
        )}

        {rule.imports.length > 0 && (
          <div className="um-row" style={{ marginTop: 6 }}>
            <span className="um-muted">@imports ({rule.imports.length}):</span>
            {rule.imports.map((imp) => (
              <span className="um-badge info um-mono" key={imp}>
                {imp}
              </span>
            ))}
          </div>
        )}

        {rule.skippedDuplicateAgentsMd.length > 0 && (
          <div className="um-row" style={{ marginTop: 6 }}>
            <span className="um-badge warn">
              Deduped native AGENTS.md ({rule.skippedDuplicateAgentsMd.length})
            </span>
          </div>
        )}

        {rule.blockedExternalTargets && rule.blockedExternalTargets.length > 0 && (
          <div className="um-row" style={{ marginTop: 6 }}>
            <span className="um-badge danger">
              Blocked external targets ({rule.blockedExternalTargets.length})
            </span>
          </div>
        )}

        {isExpanded && <pre className="um-pre">{rule.content}</pre>}
      </div>
    );
  };

  return (
    <div>
      {/* Workspace Input */}
      <div className="um-card um-section">
        <div className="um-card-header">
          <h3 className="um-card-title">CLAUDE.md &amp; .claude/rules Inspector</h3>
        </div>
        <div className="um-row">
          <input
            className="um-input"
            style={{ flex: 1, minWidth: 200 }}
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder="/path/to/workspace"
            list="um-rules-ws-hints"
          />
          <datalist id="um-rules-ws-hints">
            {workspaceHints.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <button
            className="um-btn primary"
            disabled={loading}
            onClick={() => {
              onSelectWorkspace(inputPath.trim());
              inspect(inputPath);
            }}
          >
            {loading ? 'Scanning...' : 'Inspect'}
          </button>
        </div>
      </div>

      {/* Global Rules */}
      {data && (
        <div className="um-card um-section">
          <div className="um-card-header">
            <h3 className="um-card-title">
              Global Rules ({data.globalAlwaysOn.length + data.globalConditional.length})
            </h3>
            <span className="um-muted">Managed + ~/.claude/CLAUDE.md + ~/.claude/rules/</span>
          </div>
          {data.globalAlwaysOn.length + data.globalConditional.length === 0 ? (
            <div className="um-empty">No global CLAUDE.md or ~/.claude/rules/ files found.</div>
          ) : (
            <div className="um-list">
              {data.globalAlwaysOn.map(renderRuleCard)}
              {data.globalConditional.map(renderRuleCard)}
            </div>
          )}
        </div>
      )}

      {/* External Imports & Symlinks Trust Panel (always visible for inspected workspace) */}
      {data?.workspace && (
        <div className="um-card um-section">
          <div className="um-card-header">
            <div className="um-row">
              <h3 className="um-card-title">External Imports &amp; Rule Symlinks Trust</h3>
              {data.workspace.claudeCodeExternalApproval?.approved ? (
                <span className="um-badge success">
                  Claude Code: Approved (~/.claude.json
                  {data.trustClaudeCodeExternalApprovals ? ', active' : ', ignored by setting'})
                </span>
              ) : data.workspace.claudeCodeExternalApproval?.warningShown ? (
                <span className="um-badge warn">Claude Code: Declined (~/.claude.json)</span>
              ) : (
                <span className="um-badge">Claude Code: Not approved</span>
              )}
            </div>
            <span className="um-muted">
              User-only controls · Repo rules outside workspace stay blocked unless trusted
            </span>
          </div>

          {(data.workspace.blockedExternalTargets ?? []).length === 0 &&
            (data.workspace.approvedExternalTargets ?? []).length === 0 && (
              <div className="um-muted" style={{ marginBottom: 10 }}>
                No external <code>@import</code>s or rule symlinks detected in this workspace. When
                a repository rule points outside this workspace, it will appear here for one-click
                approval or dismissal.
              </div>
            )}

          {(data.workspace.blockedExternalTargets ?? []).length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="um-muted" style={{ marginBottom: 6 }}>
                Blocked external targets ({data.workspace.blockedExternalTargets.length}):
              </div>
              <div className="um-list">
                {data.workspace.blockedExternalTargets.map((item) => {
                  const parentDir = item.targetIsDir ? null : getSafeParentDir(item.resolvedTarget);
                  return (
                    <div
                      className="um-item"
                      key={`${item.kind}-${item.sourceFile}-${item.resolvedTarget}`}
                    >
                      <div className="um-row-between">
                        <div className="um-row">
                          <span
                            className={`um-badge ${
                              item.status === 'pending_approval' ? 'danger' : 'warn'
                            }`}
                          >
                            {formatBlockStatusLabel(item.status)}
                          </span>
                          <span className="um-badge info">{formatKindLabel(item.kind)}</span>
                          <span className="um-mono">{item.sourceDisplayPath}</span>
                          {item.rawRef && (
                            <span className="um-muted um-mono">→ @{item.rawRef}</span>
                          )}
                        </div>
                        <div className="um-row">
                          <button
                            className="um-btn sm primary"
                            disabled={savingTrust}
                            onClick={() =>
                              updateExternalTrust(
                                data.workspace!.workspaceRoot,
                                'allow',
                                item.resolvedTarget,
                              )
                            }
                          >
                            {item.targetIsDir ? 'Approve Dir' : 'Approve File'}
                          </button>
                          {parentDir && (
                            <button
                              className="um-btn sm"
                              disabled={savingTrust}
                              title={parentDir}
                              onClick={() =>
                                updateExternalTrust(
                                  data.workspace!.workspaceRoot,
                                  'allow',
                                  parentDir,
                                )
                              }
                            >
                              Approve Parent Dir
                            </button>
                          )}
                          {item.status === 'denied_by_plugin' ? (
                            <button
                              className="um-btn sm"
                              disabled={savingTrust}
                              onClick={() =>
                                updateExternalTrust(
                                  data.workspace!.workspaceRoot,
                                  'revoke',
                                  item.resolvedTarget,
                                )
                              }
                            >
                              Reset
                            </button>
                          ) : (
                            <button
                              className="um-btn sm"
                              disabled={savingTrust}
                              onClick={() =>
                                updateExternalTrust(
                                  data.workspace!.workspaceRoot,
                                  'deny',
                                  item.resolvedTarget,
                                )
                              }
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="um-mono um-muted" style={{ marginTop: 4 }}>
                        Target: {item.resolvedTarget}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(data.workspace.approvedExternalTargets ?? []).length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="um-muted" style={{ marginBottom: 6 }}>
                Active external targets loaded ({data.workspace.approvedExternalTargets.length}):
              </div>
              <div className="um-list">
                {data.workspace.approvedExternalTargets.map((item) => (
                  <div
                    className="um-item"
                    key={`${item.kind}-${item.sourceDisplayPath}-${item.resolvedTarget}`}
                  >
                    <div className="um-row-between">
                      <div className="um-row">
                        <span className="um-badge success">
                          {formatApprovalSourceLabel(item.approvedBy)}
                        </span>
                        <span className="um-badge info">{formatKindLabel(item.kind)}</span>
                        <span className="um-mono">{item.sourceDisplayPath}</span>
                      </div>
                      <button
                        className="um-btn sm danger"
                        disabled={savingTrust}
                        onClick={() =>
                          updateExternalTrust(
                            data.workspace!.workspaceRoot,
                            'deny',
                            item.resolvedTarget,
                          )
                        }
                      >
                        Block
                      </button>
                    </div>
                    <div className="um-mono um-muted" style={{ marginTop: 4 }}>
                      Target: {item.resolvedTarget}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {((data.workspaceExternalTrust?.allowPaths ?? []).length > 0 ||
            (data.workspaceExternalTrust?.denyPaths ?? []).length > 0) && (
            <div style={{ marginBottom: 10 }}>
              <div className="um-row-between" style={{ marginBottom: 6 }}>
                <span className="um-muted">Saved plugin trust overrides for this workspace:</span>
                <button
                  className="um-btn sm"
                  disabled={savingTrust}
                  onClick={() =>
                    updateExternalTrust(data.workspace!.workspaceRoot, 'clear_workspace')
                  }
                >
                  Clear All Overrides
                </button>
              </div>
              <div className="um-list">
                {(data.workspaceExternalTrust?.allowPaths ?? []).map((p) => (
                  <div className="um-item um-row-between" key={`allow-${p}`}>
                    <div className="um-row">
                      <span className="um-badge success">allow</span>
                      <span className="um-mono">{p}</span>
                    </div>
                    <button
                      className="um-btn sm"
                      disabled={savingTrust}
                      onClick={() =>
                        updateExternalTrust(data.workspace!.workspaceRoot, 'revoke', p)
                      }
                    >
                      Revoke
                    </button>
                  </div>
                ))}
                {(data.workspaceExternalTrust?.denyPaths ?? []).map((p) => (
                  <div className="um-item um-row-between" key={`deny-${p}`}>
                    <div className="um-row">
                      <span className="um-badge danger">deny</span>
                      <span className="um-mono">{p}</span>
                    </div>
                    <button
                      className="um-btn sm"
                      disabled={savingTrust}
                      onClick={() =>
                        updateExternalTrust(data.workspace!.workspaceRoot, 'revoke', p)
                      }
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="um-row">
            <input
              className="um-input"
              style={{ flex: 1, minWidth: 200 }}
              value={manualTrustPath}
              onChange={(e) => setManualTrustPath(e.target.value)}
              placeholder="~/notes/writing-style.md or ~/shared-rules"
            />
            <button
              className="um-btn sm primary"
              disabled={savingTrust || !manualTrustPath.trim()}
              onClick={async () => {
                const target = manualTrustPath.trim();
                if (!target) return;
                await updateExternalTrust(data.workspace!.workspaceRoot, 'allow', target);
                setManualTrustPath('');
              }}
            >
              + Allow Path
            </button>
            <button
              className="um-btn sm"
              disabled={savingTrust || !manualTrustPath.trim()}
              onClick={async () => {
                const target = manualTrustPath.trim();
                if (!target) return;
                await updateExternalTrust(data.workspace!.workspaceRoot, 'deny', target);
                setManualTrustPath('');
              }}
            >
              + Deny Path
            </button>
          </div>
        </div>
      )}

      {/* Workspace Rules */}
      {data?.workspace && (
        <div className="um-card um-section">
          <div className="um-card-header">
            <h3 className="um-card-title">
              Workspace Rules ({data.workspace.alwaysOn.length} always-on ·{' '}
              {data.workspace.conditional.length} path-scoped)
            </h3>
            <span className="um-mono um-muted">{data.workspace.workspaceRoot}</span>
          </div>

          {data.workspace.alwaysOn.length + data.workspace.conditional.length === 0 ? (
            <div className="um-empty">
              No CLAUDE.md, CLAUDE.local.md, or .claude/rules/ files found in this workspace.
            </div>
          ) : (
            <div className="um-list">
              {data.workspace.alwaysOn.map(renderRuleCard)}
              {data.workspace.conditional.map(renderRuleCard)}
            </div>
          )}

          {data.workspace.excludedPaths.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="um-muted" style={{ marginBottom: 4 }}>
                Excluded by claudeMdExcludes:
              </div>
              <div className="um-row">
                {data.workspace.excludedPaths.map((p) => (
                  <span className="um-badge danger um-mono" key={p}>
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recent Dynamic Lazy-Load Hits */}
      {data && (
        <div className="um-card um-section">
          <div className="um-card-header">
            <h3 className="um-card-title">
              Recent Session Lazy-Load Hits ({data.recentSessionHits.length})
            </h3>
            <span className="um-muted">PostToolUse → PreInvocation dynamic injections</span>
          </div>
          {data.recentSessionHits.length === 0 ? (
            <div className="um-empty">
              No path-scoped rules or subdirectory CLAUDE.md files triggered yet.
            </div>
          ) : (
            <div className="um-list">
              {data.recentSessionHits.map((s) => (
                <div className="um-item" key={s.conversationId}>
                  <div className="um-row-between">
                    <span className="um-mono">{s.conversationId.slice(0, 12)}...</span>
                    <div className="um-row">
                      {s.compactionCount > 0 && (
                        <span className="um-badge warn">compactions: {s.compactionCount}</span>
                      )}
                      <span className="um-muted">{s.updatedAt.slice(0, 19).replace('T', ' ')}</span>
                    </div>
                  </div>
                  <div className="um-row" style={{ marginTop: 6 }}>
                    {s.loadedRuleKeys.map((k) => (
                      <span className="um-badge info um-mono" key={k}>
                        rule: {k}
                      </span>
                    ))}
                    {s.loadedSubdirPaths.map((k) => (
                      <span className="um-badge success um-mono" key={k}>
                        subdir: {k}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
