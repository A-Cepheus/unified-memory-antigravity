import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  CLAUDE_MEMORY_TYPES,
  clearDiagnosticEvents,
  deleteTopicMemory,
  discoverAllClaudeProjects,
  getClaudeConfigDir,
  getCodexHome,
  getCodexMemoryStatus,
  listCodexFiles,
  listRecentSessions,
  listTopicMemories,
  loadClaudeRulesForWorkspaces,
  loadPluginConfig,
  readCodexMemoryFile,
  readCodexSummary,
  readDiagnosticEvents,
  readMemoryIndex,
  readTopicMemory,
  resolveClaudeProject,
  resolvePluginDataDir,
  savePluginConfig,
  saveTopicMemory,
  searchCodexMemories,
  writeMemoryIndexRaw,
  type ClaudeMemoryType,
} from '../core/index.js';

export const APP_URI = 'ui://unified-memory/app.html';
export const SERVER_NAME = 'unified-memory';
export const SERVER_VERSION = '0.1.0';

export interface McpServerOptions {
  env?: NodeJS.ProcessEnv;
  pluginRoot?: string;
  dataDir?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  homeDir?: string;
}

function resolveAppHtml(options: McpServerOptions): string {
  const env = options.env ?? process.env;
  const candidates: string[] = [];

  if (env.UNIFIED_MEMORY_APP_HTML?.trim()) {
    candidates.push(env.UNIFIED_MEMORY_APP_HTML.trim());
  }
  if (options.pluginRoot) {
    candidates.push(path.join(options.pluginRoot, 'dist', 'app.html'));
  }
  if (env.PLUGIN_ROOT?.trim()) {
    candidates.push(path.join(env.PLUGIN_ROOT.trim(), 'dist', 'app.html'));
  }
  // Relative to bundled dist/mcp.cjs or process cwd
  candidates.push(path.resolve(process.cwd(), 'dist', 'app.html'));
  if (typeof __dirname === 'string') {
    candidates.push(path.resolve(__dirname, 'app.html'));
    candidates.push(path.resolve(__dirname, '..', 'dist', 'app.html'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Unified Memory</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;">
  <h2>Unified Memory UI bundle not found</h2>
  <p>Run <code>npm run build:ui</code> to build <code>dist/app.html</code>.</p>
</body>
</html>`;
}

function resolveTargetMemoryDir(
  params: { slug?: string; projectPath?: string },
  claudeConfigDir: string,
  env: NodeJS.ProcessEnv,
): { memoryDir: string; slug: string; resolvedRoot?: string } {
  if (params.projectPath?.trim()) {
    const res = resolveClaudeProject(params.projectPath.trim(), { claudeConfigDir, env });
    return { memoryDir: res.memoryDir, slug: res.slug, resolvedRoot: res.resolvedRoot };
  }
  if (params.slug?.trim()) {
    const cleanSlug = path.basename(params.slug.trim());
    if (cleanSlug !== params.slug.trim() || cleanSlug.includes('..')) {
      throw new Error(`Invalid project slug: ${params.slug}`);
    }
    return {
      memoryDir: path.join(claudeConfigDir, 'projects', cleanSlug, 'memory'),
      slug: cleanSlug,
    };
  }
  throw new Error('Either projectPath or slug must be provided');
}

function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function buildOverviewData(options: {
  claudeConfigDir: string;
  codexHome: string;
  dataDir: string;
  homeDir: string;
  initialProjectPath?: string;
  initialTab?: string;
}) {
  const claudeProjects = discoverAllClaudeProjects(options.claudeConfigDir, options.homeDir);
  const codexStatus = getCodexMemoryStatus(options.codexHome);
  const recentSessions = listRecentSessions(options.dataDir, 15);
  const diagnostics = readDiagnosticEvents(options.dataDir, 80);
  const config = loadPluginConfig(options.dataDir);
  const claudeGlobalMdPath = path.join(options.claudeConfigDir, 'CLAUDE.md');

  const workspaceHintsSet = new Set<string>();
  if (options.initialProjectPath?.trim()) {
    workspaceHintsSet.add(path.resolve(options.initialProjectPath.trim()));
  }
  for (const s of recentSessions) {
    for (const ws of s.workspacePaths) {
      if (ws) workspaceHintsSet.add(ws);
    }
  }
  for (const p of claudeProjects) {
    if (p.exactPathResolved && fs.existsSync(p.displayPath)) {
      workspaceHintsSet.add(p.displayPath);
    }
  }

  return {
    version: SERVER_VERSION,
    initialTab: options.initialTab ?? 'overview',
    initialProjectPath: options.initialProjectPath ?? null,
    pluginDataDir: options.dataDir,
    claude: {
      configDir: options.claudeConfigDir,
      exists: fs.existsSync(options.claudeConfigDir),
      hasGlobalClaudeMd: fs.existsSync(claudeGlobalMdPath),
      hasGlobalRulesDir: fs.existsSync(path.join(options.claudeConfigDir, 'rules')),
      projectCount: claudeProjects.length,
      totalTopics: claudeProjects.reduce((acc, p) => acc + p.topicCount, 0),
      projects: claudeProjects,
    },
    codex: codexStatus,
    sessions: recentSessions.map((s) => ({
      conversationId: s.conversationId,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      workspacePaths: s.workspacePaths,
      loadedRuleCount: s.loadedRuleKeys.length,
      loadedSubdirCount: s.loadedSubdirPaths.length,
      indexedConditionalCount: s.indexedConditionalRules.length,
      compactionCount: s.compactionCount,
    })),
    diagnostics,
    config,
    workspaceHints: Array.from(workspaceHintsSet),
  };
}

export function createUnifiedMemoryServer(options: McpServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const claudeConfigDir = options.claudeConfigDir ?? getClaudeConfigDir(env);
  const codexHome = options.codexHome ?? getCodexHome(env);
  const dataDir = options.dataDir ?? resolvePluginDataDir(env);
  const homeDir = options.homeDir ?? os.homedir();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  // =========================================================================
  // 1. MCP App UI Resource (`ui://unified-memory/app.html`)
  // =========================================================================
  registerAppResource(
    server,
    'Unified Memory Dashboard',
    APP_URI,
    {
      description:
        'Interactive dashboard for managing Claude Code memories/rules and browsing read-only Codex memories inside Antigravity Desktop.',
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: resolveAppHtml(options),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  // =========================================================================
  // 2. UI Launcher Tool (Global Sidebar + Aux Pane + Model Callable)
  // =========================================================================
  registerAppTool(
    server,
    'open_memory_dashboard',
    {
      title: 'Unified Memory',
      description:
        'Open the interactive Unified Memory dashboard (Claude Code read-write memory manager, Codex read-only memory explorer, CLAUDE.md/.claude/rules inspector, and live Hook diagnostics).',
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe('Optional workspace path to pre-select in the dashboard.'),
        tab: z
          .enum(['overview', 'claude', 'codex', 'rules'])
          .optional()
          .describe('Optional initial tab to open.'),
      },
      _meta: {
        ui: {
          resourceUri: APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Unified Memory' },
            { type: 'global', title: 'Unified Memory' },
          ],
        },
      },
    },
    async (args) => {
      const overview = buildOverviewData({
        claudeConfigDir,
        codexHome,
        dataDir,
        homeDir,
        initialProjectPath: args?.projectPath,
        initialTab: args?.tab,
      });

      const summary =
        `Unified Memory Dashboard ready — Claude: ${overview.claude.projectCount} projects (${overview.claude.totalTopics} topics), ` +
        `Codex: ${overview.codex.activeGeneration} (read-only), ` +
        `Recent hook diagnostics: ${overview.diagnostics.length} events.`;

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: overview as unknown as Record<string, unknown>,
      };
    },
  );

  // =========================================================================
  // 3. Model-Callable Tools (Claude Code RW + Rules + Codex Read-Only)
  // =========================================================================
  server.registerTool(
    'claude_memory_status',
    {
      title: 'Claude Memory Status',
      description:
        'Resolve a workspace path to its canonical Claude Code Auto Memory directory (handling Git worktrees, autoMemoryDirectory, and slug encoding) and report MEMORY.md budget usage.',
      inputSchema: {
        projectPath: z.string().describe('Absolute path to the workspace or project directory.'),
      },
    },
    async ({ projectPath }) => {
      const resolution = resolveClaudeProject(projectPath, { claudeConfigDir, env });
      const index = readMemoryIndex(resolution.memoryDir);
      const topics = listTopicMemories(resolution.memoryDir);
      const byType: Record<string, number> = {};
      for (const t of topics) {
        byType[t.type] = (byType[t.type] ?? 0) + 1;
      }
      const data = {
        resolution,
        index: {
          exists: index.exists,
          filePath: index.filePath,
          totalLines: index.totalLines,
          maxLines: index.maxLines,
          totalBytes: index.totalBytes,
          maxBytes: index.maxBytes,
          truncated: index.truncated,
        },
        topicCount: topics.length,
        topicsByType: byType,
      };
      return { content: [{ type: 'text', text: jsonText(data) }] };
    },
  );

  server.registerTool(
    'claude_memory_list',
    {
      title: 'List Claude Memories',
      description:
        'List all Claude Code Auto Memory topic files and MEMORY.md index summary for a project.',
      inputSchema: {
        projectPath: z.string().describe('Absolute path to the workspace or project directory.'),
        type: z
          .enum(['user', 'feedback', 'project', 'reference'])
          .optional()
          .describe('Optional filter by Claude Code memory type.'),
      },
    },
    async ({ projectPath, type }) => {
      const resolution = resolveClaudeProject(projectPath, { claudeConfigDir, env });
      const index = readMemoryIndex(resolution.memoryDir);
      let topics = listTopicMemories(resolution.memoryDir);
      if (type) topics = topics.filter((t) => t.type === type);

      const data = {
        slug: resolution.slug,
        memoryDir: resolution.memoryDir,
        autoMemoryEnabled: resolution.autoMemoryEnabled,
        index: {
          exists: index.exists,
          totalLines: index.totalLines,
          totalBytes: index.totalBytes,
          truncated: index.truncated,
          preview: index.truncatedContent,
        },
        topics: topics.map((t) => ({
          filename: t.filename,
          name: t.name,
          description: t.description,
          type: t.type,
          schema: t.schema,
          modified: t.modified,
          sizeBytes: t.sizeBytes,
        })),
      };
      return { content: [{ type: 'text', text: jsonText(data) }] };
    },
  );

  server.registerTool(
    'claude_memory_read',
    {
      title: 'Read Claude Memory File',
      description:
        'Read MEMORY.md (when filename is omitted) or a specific Claude Code topic memory markdown file.',
      inputSchema: {
        projectPath: z.string().describe('Absolute path to the workspace or project directory.'),
        filename: z
          .string()
          .optional()
          .describe('Topic filename (e.g. "feedback_testing.md"). Omit to read MEMORY.md.'),
      },
    },
    async ({ projectPath, filename }) => {
      const resolution = resolveClaudeProject(projectPath, { claudeConfigDir, env });
      if (!filename || filename.trim() === '' || filename.trim() === 'MEMORY.md') {
        const index = readMemoryIndex(resolution.memoryDir);
        return { content: [{ type: 'text', text: jsonText(index) }] };
      }
      const topic = readTopicMemory(resolution.memoryDir, filename.trim());
      if (!topic) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Topic file "${filename}" not found in ${resolution.memoryDir}`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: jsonText(topic) }] };
    },
  );

  server.registerTool(
    'claude_memory_save',
    {
      title: 'Save Claude Memory',
      description:
        'Create or update a Claude Code Auto Memory topic file using the latest v2.1.x nested metadata schema (`node_type: memory`), with cross-process locking, atomic writes, and automatic MEMORY.md index sync.',
      inputSchema: {
        projectPath: z.string().describe('Absolute path to the workspace or project directory.'),
        name: z.string().min(1).describe('Short slug or title for this memory topic.'),
        description: z
          .string()
          .min(1)
          .describe('Concise one-line description used for relevance recall and MEMORY.md index.'),
        type: z
          .enum(['user', 'feedback', 'project', 'reference'])
          .describe('Claude Code memory category.'),
        body: z.string().min(1).describe('Markdown content of the memory note.'),
        filename: z
          .string()
          .optional()
          .describe('Optional explicit filename (e.g. "feedback_db_tests.md"). Derived from name if omitted.'),
        originSessionId: z
          .string()
          .optional()
          .describe('Optional conversation/session ID recorded in metadata.originSessionId.'),
      },
    },
    async ({ projectPath, name, description, type, body, filename, originSessionId }) => {
      const resolution = resolveClaudeProject(projectPath, { claudeConfigDir, env });
      if (!resolution.autoMemoryEnabled) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Claude Auto Memory is disabled in settings or via CLAUDE_CODE_DISABLE_AUTO_MEMORY.',
            },
          ],
        };
      }
      const result = saveTopicMemory(resolution.memoryDir, {
        filename,
        name,
        description,
        type: type as ClaudeMemoryType,
        body,
        originSessionId,
      });
      return {
        content: [
          {
            type: 'text',
            text: jsonText({
              saved: true,
              slug: resolution.slug,
              filePath: result.topic.filePath,
              filename: result.topic.filename,
              schema: result.topic.schema,
              modified: result.topic.modified,
              indexLines: result.index.totalLines,
              indexBytes: result.index.totalBytes,
              warnings: result.warnings,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'claude_memory_delete',
    {
      title: 'Delete Claude Memory',
      description:
        'Delete a Claude Code topic memory file and atomically remove its pointer line from MEMORY.md.',
      inputSchema: {
        projectPath: z.string().describe('Absolute path to the workspace or project directory.'),
        filename: z.string().describe('Filename of the topic markdown file to delete.'),
      },
    },
    async ({ projectPath, filename }) => {
      const resolution = resolveClaudeProject(projectPath, { claudeConfigDir, env });
      const res = deleteTopicMemory(resolution.memoryDir, filename);
      return {
        content: [
          {
            type: 'text',
            text: jsonText({
              deleted: res.deleted,
              filename,
              memoryDir: resolution.memoryDir,
              remainingIndexLines: res.index.totalLines,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'claude_rules_inspect',
    {
      title: 'Inspect Claude Rules & CLAUDE.md',
      description:
        'Inspect all CLAUDE.md hierarchy files (with @import chains and AGENTS.md deduplication) and .claude/rules/ files (always-on vs paths-scoped) for a workspace.',
      inputSchema: {
        workspacePath: z.string().describe('Absolute path to the workspace directory.'),
      },
    },
    async ({ workspacePath }) => {
      const cfg = loadPluginConfig(dataDir);
      const loaded = loadClaudeRulesForWorkspaces([workspacePath], {
        claudeConfigDir,
        deduplicateNativeAgentsMd: cfg.deduplicateNativeAgentsMd,
      });
      const ws = loaded.workspaces[0];
      const summarize = (r: (typeof loaded.globalAlwaysOn)[number]) => ({
        displayPath: r.displayPath,
        filePath: r.filePath,
        scope: r.scope,
        isConditional: r.isConditional,
        paths: r.paths,
        imports: r.imports,
        skippedDuplicateAgentsMd: r.skippedDuplicateAgentsMd,
        sizeBytes: r.sizeBytes,
      });
      return {
        content: [
          {
            type: 'text',
            text: jsonText({
              workspacePath: path.resolve(workspacePath),
              globalAlwaysOn: loaded.globalAlwaysOn.map(summarize),
              globalConditional: loaded.globalConditional.map(summarize),
              projectAlwaysOn: ws ? ws.alwaysOn.map(summarize) : [],
              projectConditional: ws ? ws.conditional.map(summarize) : [],
              excludedPaths: ws ? ws.excludedPaths : [],
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'codex_memory_summary',
    {
      title: 'Codex Memory Summary (Read-Only)',
      description:
        'Read-only overview of OpenAI Codex CLI local memories (~/.codex/memories_v2 preferred, fallback ~/.codex/memories) and memory_summary.md.',
      inputSchema: {
        generation: z
          .enum(['auto', 'v2', 'v1'])
          .optional()
          .describe('Which Codex memory generation to inspect (default: auto).'),
        maxBytes: z
          .number()
          .int()
          .min(512)
          .max(65536)
          .optional()
          .describe('Maximum bytes of memory_summary.md to return (default: 12288).'),
      },
    },
    async ({ generation, maxBytes }) => {
      const status = getCodexMemoryStatus(codexHome);
      const summary = readCodexSummary({
        codexHome,
        generation: generation ?? 'auto',
        maxBytes: maxBytes ?? 12 * 1024,
      });
      return {
        content: [
          {
            type: 'text',
            text: jsonText({
              readOnly: true,
              status,
              summary,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'codex_memory_search',
    {
      title: 'Search Codex Memories (Read-Only)',
      description:
        'Search across read-only Codex memories (memory_summary.md, rollout_summaries, extensions/ad_hoc, skills, and v1 MEMORY.md handbook), optionally weighted by project name.',
      inputSchema: {
        query: z.string().min(1).describe('Keywords or topic to search for.'),
        projectHint: z
          .string()
          .optional()
          .describe('Optional current repo/project name to boost relevant cross-repo results.'),
        generation: z
          .enum(['auto', 'v2', 'v1', 'both'])
          .optional()
          .describe('Generation scope to search (default: auto).'),
        limit: z.number().int().min(1).max(30).optional().describe('Max hits to return (default: 10).'),
      },
    },
    async ({ query, projectHint, generation, limit }) => {
      const hits = searchCodexMemories(query, {
        codexHome,
        projectHint,
        generation: generation ?? 'auto',
        limit: limit ?? 10,
      });
      return {
        content: [
          {
            type: 'text',
            text: jsonText({ readOnly: true, query, projectHint: projectHint ?? null, hits }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'codex_memory_read',
    {
      title: 'Read Codex Memory File (Read-Only)',
      description:
        'Read a specific markdown file inside ~/.codex/memories_v2 or ~/.codex/memories (strictly read-only and path-jailed).',
      inputSchema: {
        generation: z.enum(['v2', 'v1']).describe('Codex memory generation ("v2" or "v1").'),
        relativePath: z
          .string()
          .describe('Relative path such as "rollout_summaries/<slug>.md" or "extensions/ad_hoc/instructions.md".'),
        maxBytes: z.number().int().min(512).max(131072).optional(),
      },
    },
    async ({ generation, relativePath, maxBytes }) => {
      const result = readCodexMemoryFile(generation, relativePath, codexHome, maxBytes ?? 48 * 1024);
      return { content: [{ type: 'text', text: jsonText({ readOnly: true, ...result }) }] };
    },
  );

  // =========================================================================
  // 4. App-Only UI Tools (hidden from model via `_meta.ui.visibility = ["app"]`)
  // =========================================================================
  const APP_ONLY_META = { ui: { visibility: ['app'] as Array<'app'> } };

  server.registerTool(
    'ui_get_overview',
    {
      description: 'App-only: fetch full dashboard overview data.',
      _meta: APP_ONLY_META,
    },
    async () => {
      const overview = buildOverviewData({ claudeConfigDir, codexHome, dataDir, homeDir });
      return {
        content: [{ type: 'text', text: jsonText(overview) }],
        structuredContent: overview as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_resolve_project',
    {
      description: 'App-only: resolve a filesystem path to its Claude slug & memory directory.',
      inputSchema: { inputPath: z.string() },
      _meta: APP_ONLY_META,
    },
    async ({ inputPath }) => {
      const resolution = resolveClaudeProject(inputPath, { claudeConfigDir, env });
      return {
        content: [{ type: 'text', text: jsonText(resolution) }],
        structuredContent: resolution as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_get_project_memories',
    {
      description: 'App-only: load MEMORY.md and all parsed topic memories for a project.',
      inputSchema: {
        slug: z.string().optional(),
        projectPath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ slug, projectPath }) => {
      const target = resolveTargetMemoryDir({ slug, projectPath }, claudeConfigDir, env);
      const index = readMemoryIndex(target.memoryDir);
      const topics = listTopicMemories(target.memoryDir);
      const payload = {
        slug: target.slug,
        resolvedRoot: target.resolvedRoot ?? null,
        memoryDir: target.memoryDir,
        index,
        topics,
      };
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_save_topic',
    {
      description: 'App-only: create or update a Claude topic memory from the UI.',
      inputSchema: {
        slug: z.string().optional(),
        projectPath: z.string().optional(),
        filename: z.string().optional(),
        name: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(CLAUDE_MEMORY_TYPES as [ClaudeMemoryType, ...ClaudeMemoryType[]]),
        body: z.string().min(1),
      },
      _meta: APP_ONLY_META,
    },
    async ({ slug, projectPath, filename, name, description, type, body }) => {
      const target = resolveTargetMemoryDir({ slug, projectPath }, claudeConfigDir, env);
      const res = saveTopicMemory(target.memoryDir, {
        filename,
        name,
        description,
        type,
        body,
      });
      const payload = {
        slug: target.slug,
        topic: res.topic,
        index: res.index,
        warnings: res.warnings,
      };
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_delete_topic',
    {
      description: 'App-only: delete a Claude topic memory from the UI.',
      inputSchema: {
        slug: z.string().optional(),
        projectPath: z.string().optional(),
        filename: z.string().min(1),
      },
      _meta: APP_ONLY_META,
    },
    async ({ slug, projectPath, filename }) => {
      const target = resolveTargetMemoryDir({ slug, projectPath }, claudeConfigDir, env);
      const res = deleteTopicMemory(target.memoryDir, filename);
      const payload = { slug: target.slug, deleted: res.deleted, index: res.index };
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_save_memory_index',
    {
      description: 'App-only: directly save MEMORY.md content from the UI.',
      inputSchema: {
        slug: z.string().optional(),
        projectPath: z.string().optional(),
        content: z.string(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ slug, projectPath, content }) => {
      const target = resolveTargetMemoryDir({ slug, projectPath }, claudeConfigDir, env);
      const index = writeMemoryIndexRaw(target.memoryDir, content);
      const payload = { slug: target.slug, index };
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_browse_codex',
    {
      description: 'App-only: browse, search, or read Codex memory files (strictly read-only).',
      inputSchema: {
        generation: z.enum(['auto', 'v2', 'v1']).optional(),
        query: z.string().optional(),
        projectHint: z.string().optional(),
        readGeneration: z.enum(['v2', 'v1']).optional(),
        readRelativePath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ generation, query, projectHint, readGeneration, readRelativePath }) => {
      const status = getCodexMemoryStatus(codexHome);
      const activeGen =
        generation && generation !== 'auto'
          ? generation
          : status.activeGeneration === 'none'
            ? 'v2'
            : status.activeGeneration;

      const summary = readCodexSummary({
        codexHome,
        generation: activeGen,
        maxBytes: 32 * 1024,
      });
      const files = listCodexFiles(activeGen, codexHome);
      const hits =
        query && query.trim()
          ? searchCodexMemories(query.trim(), {
              codexHome,
              projectHint: projectHint?.trim() || undefined,
              generation: 'both',
              limit: 25,
            })
          : [];

      let fileContent: ReturnType<typeof readCodexMemoryFile> | null = null;
      if (readGeneration && readRelativePath) {
        fileContent = readCodexMemoryFile(readGeneration, readRelativePath, codexHome, 64 * 1024);
      }

      const payload = {
        readOnly: true,
        status,
        selectedGeneration: activeGen,
        summary,
        files,
        hits,
        fileContent,
      };
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_inspect_rules',
    {
      description: 'App-only: inspect CLAUDE.md hierarchy, @imports, and .claude/rules for a workspace.',
      inputSchema: {
        workspacePath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ workspacePath }) => {
      const cfg = loadPluginConfig(dataDir);
      const wsList = workspacePath?.trim() ? [workspacePath.trim()] : [];
      const loaded = loadClaudeRulesForWorkspaces(wsList, {
        claudeConfigDir,
        deduplicateNativeAgentsMd: cfg.deduplicateNativeAgentsMd,
      });
      const sessions = listRecentSessions(dataDir, 10);
      const payload = {
        workspacePath: wsList[0] ? path.resolve(wsList[0]) : null,
        globalAlwaysOn: loaded.globalAlwaysOn,
        globalConditional: loaded.globalConditional,
        workspace: loaded.workspaces[0] ?? null,
        recentSessionHits: sessions
          .filter((s) => s.loadedRuleKeys.length > 0 || s.loadedSubdirPaths.length > 0)
          .map((s) => ({
            conversationId: s.conversationId,
            updatedAt: s.updatedAt,
            loadedRuleKeys: s.loadedRuleKeys,
            loadedSubdirPaths: s.loadedSubdirPaths,
            compactionCount: s.compactionCount,
          })),
      };
      return {
        content: [{ type: 'text', text: jsonText(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_update_config',
    {
      description: 'App-only: update Unified Memory plugin runtime settings.',
      inputSchema: {
        injectCodexSummaryOnStart: z.boolean().optional(),
        codexSummaryMaxBytes: z.number().int().min(512).max(65536).optional(),
        injectCodexGlobalAgentsMd: z.boolean().optional(),
        deduplicateNativeAgentsMd: z.boolean().optional(),
        maxStartupInjectBytes: z.number().int().min(4096).max(262144).optional(),
      },
      _meta: APP_ONLY_META,
    },
    async (patch) => {
      const updated = savePluginConfig(patch, dataDir);
      return {
        content: [{ type: 'text', text: jsonText(updated) }],
        structuredContent: updated as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'ui_clear_diagnostics',
    {
      description: 'App-only: clear diagnostic hook event history.',
      _meta: APP_ONLY_META,
    },
    async () => {
      clearDiagnosticEvents(dataDir);
      return {
        content: [{ type: 'text', text: '{"cleared":true}' }],
        structuredContent: { cleared: true },
      };
    },
  );

  return server;
}

async function runStdio(): Promise<void> {
  const server = createUnifiedMemoryServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run stdio transport when launched directly as bundled entry (`dist/mcp.cjs`)
const isDirectMain =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;

if (isDirectMain || process.argv[1]?.endsWith('mcp.cjs') || process.argv[1]?.endsWith('mcp/index.ts')) {
  runStdio().catch((err) => {
    process.stderr.write(`[unified-memory-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
