import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { CallToolFn, OverviewPayload, TabId } from './types.js';
import { OverviewTab } from './components/OverviewTab.js';
import { ClaudeTab } from './components/ClaudeTab.js';
import { CodexTab } from './components/CodexTab.js';
import { RulesTab } from './components/RulesTab.js';

function extractPayload<T>(result: {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): T {
  if (result.isError) {
    const errText =
      result.content?.find((c) => c.type === 'text')?.text ?? 'Tool call failed';
    throw new Error(errText);
  }
  if (result.structuredContent) {
    return result.structuredContent as unknown as T;
  }
  const textBlock = result.content?.find((c) => c.type === 'text')?.text;
  if (textBlock) {
    return JSON.parse(textBlock) as T;
  }
  throw new Error('Empty response from MCP server');
}

export const AppView: React.FC = () => {
  const [tab, setTab] = useState<TabId>('overview');
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [toast, setToast] = useState<{
    msg: string;
    tone: 'info' | 'success' | 'warn' | 'danger';
  } | null>(null);
  const receivedInitialToolResult = useRef(false);

  const notify = useCallback(
    (msg: string, tone: 'info' | 'success' | 'warn' | 'danger' = 'info') => {
      setToast({ msg, tone });
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const applyOverview = useCallback((data: OverviewPayload) => {
    setOverview(data);
    setLoading(false);
    if (data.initialTab) {
      setTab(data.initialTab);
    }
    if (data.initialProjectPath) {
      setSelectedWorkspace(data.initialProjectPath);
    } else if (data.workspaceHints.length > 0) {
      setSelectedWorkspace((prev) => prev || data.workspaceHints[0]);
    }
    if (data.claude.projects.length > 0) {
      setSelectedSlug((prev) => prev || data.claude.projects[0].slug);
    }
  }, []);

  const { app, isConnected, error } = useApp({
    appInfo: { name: 'Unified Memory', version: '0.2.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => {
        try {
          const parsed = extractPayload<OverviewPayload>(
            result as unknown as {
              structuredContent?: Record<string, unknown>;
              content?: Array<{ type: string; text?: string }>;
              isError?: boolean;
            },
          );
          if (parsed && parsed.claude && parsed.codex) {
            receivedInitialToolResult.current = true;
            applyOverview(parsed);
          }
        } catch {
          // ignore non-overview tool results
        }
      };
    },
  });

  useHostStyles(app, app?.getHostContext());

  const callTool: CallToolFn = useCallback(
    async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (!app) throw new Error('MCP App bridge not connected yet');
      const result = await app.callServerTool({ name, arguments: args });
      return extractPayload<T>(
        result as unknown as {
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        },
      );
    },
    [app],
  );

  const refreshOverview = useCallback(async () => {
    if (!app) return;
    setLoading(true);
    try {
      const data = await callTool<OverviewPayload>('ui_get_overview', {});
      applyOverview(data);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'danger');
      setLoading(false);
    }
  }, [app, callTool, applyOverview, notify]);

  // If opened directly via entrypoint or reopened without cached result, fetch overview
  useEffect(() => {
    if (!isConnected || !app) return;
    const timer = window.setTimeout(() => {
      if (!receivedInitialToolResult.current) {
        refreshOverview();
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [isConnected, app, refreshOverview]);

  if (error) {
    return (
      <div className="um-main">
        <div className="um-banner danger">
          Failed to connect to Antigravity MCP App host: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="um-shell">
      <header className="um-header">
        <div className="um-header-top">
          <div className="um-brand">
            <span className="um-brand-dot" />
            <h1 className="um-title">Unified Memory</h1>
            <span className="um-badge">v{overview?.version ?? '0.2.0'}</span>
          </div>
          <div className="um-row">
            <span className={`um-badge ${isConnected ? 'success' : 'warn'}`}>
              {isConnected ? 'Connected' : 'Connecting...'}
            </span>
            <button
              className="um-btn sm"
              onClick={refreshOverview}
              disabled={!isConnected || loading}
            >
              {loading ? 'Loading...' : 'Sync'}
            </button>
          </div>
        </div>

        <nav className="um-tabs" aria-label="Unified Memory Views">
          <button
            className={`um-tab ${tab === 'overview' ? 'active' : ''}`}
            onClick={() => setTab('overview')}
          >
            Overview &amp; Diagnostics
          </button>
          <button
            className={`um-tab ${tab === 'claude' ? 'active' : ''}`}
            onClick={() => setTab('claude')}
          >
            Claude Memory ({overview?.claude.totalTopics ?? 0})
          </button>
          <button
            className={`um-tab ${tab === 'codex' ? 'active' : ''}`}
            onClick={() => setTab('codex')}
          >
            Codex Memory (RO)
          </button>
          <button
            className={`um-tab ${tab === 'rules' ? 'active' : ''}`}
            onClick={() => setTab('rules')}
          >
            Rules &amp; Context
          </button>
        </nav>
      </header>

      <main className="um-main">
        {toast && (
          <div className={`um-banner ${toast.tone}`}>
            <span>{toast.msg}</span>
            <button className="um-btn sm" onClick={() => setToast(null)}>
              Dismiss
            </button>
          </div>
        )}

        {!overview ? (
          <div className="um-empty">
            {isConnected ? 'Loading memory & rules inventory...' : 'Connecting to Antigravity...'}
          </div>
        ) : (
          <>
            {tab === 'overview' && (
              <OverviewTab
                overview={overview}
                callTool={callTool}
                onRefresh={refreshOverview}
                onSelectClaudeProject={(slug) => {
                  setSelectedSlug(slug);
                  setTab('claude');
                }}
                onSelectRulesWorkspace={(wsPath) => {
                  setSelectedWorkspace(wsPath);
                  setTab('rules');
                }}
                onNotify={notify}
              />
            )}

            {tab === 'claude' && (
              <ClaudeTab
                projects={overview.claude.projects}
                selectedSlug={selectedSlug}
                onSelectSlug={setSelectedSlug}
                callTool={callTool}
                onOverviewRefresh={refreshOverview}
                onNotify={notify}
              />
            )}

            {tab === 'codex' && (
              <CodexTab
                callTool={callTool}
                defaultProjectHint={
                  selectedWorkspace ? selectedWorkspace.split('/').pop() ?? '' : ''
                }
                onNotify={notify}
              />
            )}

            {tab === 'rules' && (
              <RulesTab
                workspaceHints={overview.workspaceHints}
                selectedWorkspace={selectedWorkspace}
                onSelectWorkspace={setSelectedWorkspace}
                callTool={callTool}
                onNotify={notify}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};
