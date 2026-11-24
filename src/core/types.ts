export type ClaudeMemoryType = 'user' | 'feedback' | 'project' | 'reference';

export const CLAUDE_MEMORY_TYPES: readonly ClaudeMemoryType[] = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;

export type ClaudeFrontmatterSchema = 'nested_metadata' | 'flat' | 'none';

export interface ClaudeMemoryTopic {
  filename: string;
  filePath: string;
  name: string;
  description: string;
  type: ClaudeMemoryType | string;
  nodeType?: string;
  originSessionId?: string;
  modified?: string;
  schema: ClaudeFrontmatterSchema;
  body: string;
  rawContent: string;
  sizeBytes: number;
  lineCount: number;
  mtimeMs: number;
}

export interface ClaudeMemoryIndex {
  filePath: string;
  exists: boolean;
  content: string;
  truncatedContent: string;
  totalLines: number;
  totalBytes: number;
  includedLines: number;
  includedBytes: number;
  truncated: boolean;
  maxLines: number;
  maxBytes: number;
  mtimeMs: number;
}

export interface ClaudeMergedSettings {
  autoMemoryEnabled: boolean;
  autoMemoryDirectory?: string;
  claudeMdExcludes: string[];
  disabledByEnv: boolean;
}

export interface ClaudeProjectResolution {
  inputPath: string;
  resolvedRoot: string;
  gitCommonDir?: string;
  isGitWorktree: boolean;
  slug: string;
  memoryDir: string;
  autoMemoryEnabled: boolean;
  autoMemoryOverride?: string;
  disabledByEnv: boolean;
  exists: boolean;
}

export interface ClaudeProjectSummary {
  slug: string;
  displayPath: string;
  exactPathResolved: boolean;
  memoryDir: string;
  hasMemoryDir: boolean;
  hasMemoryIndex: boolean;
  indexLines: number;
  indexBytes: number;
  topicCount: number;
  lastModifiedMs: number;
}

export type ClaudeRuleScope =
  | 'managed'
  | 'user'
  | 'user_rule'
  | 'ancestor'
  | 'project'
  | 'project_rule'
  | 'local'
  | 'subdir';

export interface ClaudeRuleEntry {
  id: string;
  filePath: string;
  displayPath: string;
  scope: ClaudeRuleScope;
  workspaceRoot?: string;
  paths: string[] | null;
  isConditional: boolean;
  content: string;
  imports: string[];
  skippedDuplicateAgentsMd: string[];
  sizeBytes: number;
  mtimeMs: number;
}

export interface WorkspaceRulesBundle {
  workspaceRoot: string;
  alwaysOn: ClaudeRuleEntry[];
  conditional: ClaudeRuleEntry[];
  excludedPaths: string[];
}

export interface CodexGenerationStats {
  generation: 'v2' | 'v1';
  dirPath: string;
  exists: boolean;
  hasSummary: boolean;
  summaryBytes: number;
  summaryLines: number;
  summaryMtimeMs: number;
  hasHandbook: boolean;
  handbookBytes: number;
  rolloutCount: number;
  extensionFiles: string[];
  skillNames: string[];
}

export interface CodexMemoryStatus {
  codexHome: string;
  exists: boolean;
  configFlags: {
    featuresMemories?: boolean;
    generateMemories?: boolean;
    useMemories?: boolean;
  };
  activeGeneration: 'v2' | 'v1' | 'none';
  v2: CodexGenerationStats;
  v1: CodexGenerationStats;
  hasGlobalAgentsMd: boolean;
  hasGlobalAgentsOverrideMd: boolean;
}

export interface CodexSearchHit {
  generation: 'v2' | 'v1';
  category: 'summary' | 'handbook' | 'rollout' | 'extension' | 'skill';
  relativePath: string;
  title: string;
  score: number;
  snippet: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface IndexedConditionalRule {
  id: string;
  filePath: string;
  displayPath: string;
  workspaceRoot: string;
  paths: string[];
  scope: ClaudeRuleScope;
}

export interface PendingInjection {
  key: string;
  kind: 'scoped_rule' | 'subdir_claude_md';
  filePath: string;
  displayPath: string;
  workspaceRoot: string;
  triggeredBy: string;
  queuedAt: string;
}

export interface SessionState {
  conversationId: string;
  sessionStarted: boolean;
  startedAt: string;
  workspacePaths: string[];
  loadedRuleKeys: string[];
  loadedSubdirPaths: string[];
  indexedConditionalRules: IndexedConditionalRule[];
  pendingInjections: PendingInjection[];
  fileMtimes: Record<string, number>;
  lastInitialNumSteps: number;
  transcriptByteOffset: number;
  compactionCount: number;
  updatedAt: string;
}

export interface DiagnosticEvent {
  ts: string;
  event: string;
  conversationId: string;
  elapsedMs: number;
  workspacePaths: string[];
  injectedCount: number;
  injectedLabels: string[];
  toolName?: string;
  triggeredBy?: string;
  compactionReload?: boolean;
  hotReload?: boolean;
  error?: string;
}

export interface UnifiedMemoryConfig {
  injectCodexSummaryOnStart: boolean;
  codexSummaryMaxBytes: number;
  injectCodexGlobalAgentsMd: boolean;
  deduplicateNativeAgentsMd: boolean;
  maxStartupInjectBytes: number;
}

export const DEFAULT_CONFIG: UnifiedMemoryConfig = {
  injectCodexSummaryOnStart: true,
  codexSummaryMaxBytes: 8 * 1024,
  injectCodexGlobalAgentsMd: false,
  deduplicateNativeAgentsMd: true,
  maxStartupInjectBytes: 64 * 1024,
};
