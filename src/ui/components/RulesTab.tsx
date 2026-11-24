import React, { useEffect, useState } from 'react';
import type { CallToolFn, ClaudeRuleEntry, RulesInspectPayload } from '../types.js';

interface Props {
  workspaceHints: string[];
  selectedWorkspace: string;
  onSelectWorkspace: (ws: string) => void;
  callTool: CallToolFn;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void;
}

export const RulesTab: React.FC<Props> = ({
  workspaceHints,
  selectedWorkspace,
  onSelectWorkspace,
  callTool,
  onNotify,
}) => {
  const [inputPath, setInputPath] = useState(selectedWorkspace || workspaceHints[0] || '');
  const [data, setData] = useState<RulesInspectPayload | null>(null);
  const [loading, setLoading] = useState(false);
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
