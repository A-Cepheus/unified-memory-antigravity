import type {
  ApprovedExternalRuleTarget,
  BlockedExternalRuleTarget,
  ClaudeCodeExternalApprovalState,
  ClaudeMemoryIndex,
  ClaudeMemoryTopic,
  ClaudeMemoryType,
  ClaudeProjectResolution,
  ClaudeProjectSummary,
  ClaudeRuleEntry,
  CodexMemoryStatus,
  CodexSearchHit,
  DiagnosticEvent,
  UnifiedMemoryConfig,
  WorkspaceExternalTrustConfig,
  WorkspaceRulesBundle,
} from '../core/types.js';

export type TabId = 'overview' | 'claude' | 'codex' | 'rules';

export interface OverviewPayload {
  version: string;
  initialTab?: TabId;
  initialProjectPath?: string | null;
  pluginDataDir: string;
  claude: {
    configDir: string;
    exists: boolean;
    hasGlobalClaudeMd: boolean;
    hasGlobalRulesDir: boolean;
    projectCount: number;
    totalTopics: number;
    projects: ClaudeProjectSummary[];
  };
  codex: CodexMemoryStatus;
  sessions: Array<{
    conversationId: string;
    startedAt: string;
    updatedAt: string;
    workspacePaths: string[];
    loadedRuleCount: number;
    loadedSubdirCount: number;
    indexedConditionalCount: number;
    compactionCount: number;
  }>;
  diagnostics: DiagnosticEvent[];
  config: UnifiedMemoryConfig;
  workspaceHints: string[];
}

export interface ProjectMemoriesPayload {
  slug: string;
  resolvedRoot: string | null;
  memoryDir: string;
  index: ClaudeMemoryIndex;
  topics: ClaudeMemoryTopic[];
}

export interface CodexBrowsePayload {
  readOnly: true;
  status: CodexMemoryStatus;
  selectedGeneration: 'v2' | 'v1';
  summary: {
    generation: 'v2' | 'v1' | 'none';
    filePath?: string;
    content: string;
    truncated: boolean;
    totalBytes: number;
    mtimeMs: number;
  };
  files: Array<{
    category: CodexSearchHit['category'];
    relativePath: string;
    title: string;
    sizeBytes: number;
    mtimeMs: number;
  }>;
  hits: CodexSearchHit[];
  fileContent: {
    generation: 'v2' | 'v1';
    relativePath: string;
    filePath: string;
    content: string;
    truncated: boolean;
    totalBytes: number;
    mtimeMs: number;
  } | null;
}

export interface RulesInspectPayload {
  workspacePath: string | null;
  globalAlwaysOn: ClaudeRuleEntry[];
  globalConditional: ClaudeRuleEntry[];
  workspace: WorkspaceRulesBundle | null;
  workspaceExternalTrust: WorkspaceExternalTrustConfig;
  trustClaudeCodeExternalApprovals: boolean;
  recentSessionHits: Array<{
    conversationId: string;
    updatedAt: string;
    loadedRuleKeys: string[];
    loadedSubdirPaths: string[];
    compactionCount: number;
  }>;
}

export type CallToolFn = <T = Record<string, unknown>>(
  name: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type {
  ApprovedExternalRuleTarget,
  BlockedExternalRuleTarget,
  ClaudeCodeExternalApprovalState,
  ClaudeMemoryIndex,
  ClaudeMemoryTopic,
  ClaudeMemoryType,
  ClaudeProjectResolution,
  ClaudeProjectSummary,
  ClaudeRuleEntry,
  CodexMemoryStatus,
  CodexSearchHit,
  DiagnosticEvent,
  UnifiedMemoryConfig,
  WorkspaceExternalTrustConfig,
};
