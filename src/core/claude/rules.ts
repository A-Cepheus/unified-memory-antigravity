import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ClaudeRuleEntry,
  ClaudeRuleScope,
  WorkspaceRulesBundle,
} from '../types.js';
import { parseFrontmatter } from './frontmatter.js';
import { expandHome, getClaudeConfigDir, readClaudeSettings } from './paths.js';

const MAX_IMPORT_DEPTH = 5;

/**
 * Expands simple brace expressions like `src/api/{a,b}.ts` into flat globs.
 */
export function expandBraceGlob(pattern: string): string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  const options = match[1].split(',');
  const results: string[] = [];
  for (const opt of options) {
    for (const expanded of expandBraceGlob(`${prefix}${opt}${suffix}`)) {
      results.push(expanded);
    }
  }
  return results;
}

/**
 * Converts a glob pattern (supporting `**`, `*`, `?`, `{a,b}`) into a RegExp
 * matching POSIX forward-slash paths.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let rx = '^';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` matches zero or more path segments
        if (normalized[i + 2] === '/') {
          rx += '(?:.*/)?';
          i += 3;
          continue;
        }
        rx += '.*';
        i += 2;
        continue;
      }
      rx += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      rx += '[^/]';
      i++;
      continue;
    }
    if ('^$.|+()[]{}'.includes(ch)) {
      rx += `\\${ch}`;
    } else {
      rx += ch;
    }
    i++;
  }
  rx += '$';
  return new RegExp(rx);
}

export function matchesGlobPatterns(targetPath: string, patterns: string[]): boolean {
  const normTarget = targetPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim();
    if (!trimmed) continue;
    for (const expanded of expandBraceGlob(trimmed)) {
      const re = globToRegExp(expanded);
      if (re.test(normTarget)) return true;
      // Also allow matching basename when pattern has no slash (e.g., "*.ts")
      if (!expanded.includes('/') && re.test(path.posix.basename(normTarget))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strips HTML comments (`<!-- ... -->`) outside Markdown fenced code blocks
 * and inline code spans, matching Claude Code's CLAUDE.md token optimization.
 */
export function stripHtmlComments(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let inHtmlComment = false;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!inHtmlComment && fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    let result = '';
    let i = 0;
    let inInlineCode = false;

    while (i < line.length) {
      if (inHtmlComment) {
        const endIdx = line.indexOf('-->', i);
        if (endIdx === -1) {
          i = line.length;
        } else {
          inHtmlComment = false;
          i = endIdx + 3;
        }
        continue;
      }

      if (line[i] === '`') {
        inInlineCode = !inInlineCode;
        result += line[i];
        i++;
        continue;
      }

      if (!inInlineCode && line.startsWith('<!--', i)) {
        const endIdx = line.indexOf('-->', i + 4);
        if (endIdx === -1) {
          inHtmlComment = true;
          i = line.length;
        } else {
          i = endIdx + 3;
        }
        continue;
      }

      result += line[i];
      i++;
    }

    // Preserve empty lines only if they weren't wholly comment lines
    if (result.trim() !== '' || line.trim() === '') {
      out.push(result);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeRealpath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isNativeAntigravityRuleInWorkspace(
  resolvedPath: string,
  workspaceRoots: string[],
): boolean {
  const base = path.basename(resolvedPath);
  if (base !== 'AGENTS.md' && base !== 'GEMINI.md') return false;
  for (const ws of workspaceRoots) {
    const normWs = safeRealpath(ws);
    if (resolvedPath === normWs || resolvedPath.startsWith(normWs + path.sep)) {
      return true;
    }
  }
  return false;
}

export interface ExpandImportsResult {
  content: string;
  imports: string[];
  skippedDuplicateAgentsMd: string[];
}

/**
 * Expands Claude Code `@path` / `@import path` references recursively up to 5 hops,
 * skipping fenced code blocks and inline backticks, with cycle detection and
 * optional deduplication against native workspace `AGENTS.md` / `GEMINI.md`.
 */
export function expandAtImports(
  rawContent: string,
  sourceFilePath: string,
  options?: {
    workspaceRoots?: string[];
    deduplicateNativeAgentsMd?: boolean;
    maxDepth?: number;
  },
): ExpandImportsResult {
  const workspaceRoots = options?.workspaceRoots ?? [];
  const deduplicateNativeAgentsMd = options?.deduplicateNativeAgentsMd ?? true;
  const maxDepth = options?.maxDepth ?? MAX_IMPORT_DEPTH;

  const imports: string[] = [];
  const skippedDuplicateAgentsMd: string[] = [];

  function processText(content: string, currentFile: string, depth: number, stack: Set<string>): string {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let inFence = false;
    let fenceChar = '';

    for (const line of lines) {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceChar = fenceMatch[1][0];
        } else if (fenceMatch[1][0] === fenceChar) {
          inFence = false;
          fenceChar = '';
        }
        out.push(line);
        continue;
      }

      if (inFence || depth >= maxDepth) {
        out.push(line);
        continue;
      }

      // Check standalone `@import path` or `@path/to/file.md` lines (ignoring code spans)
      const standaloneMatch =
        /^\s*(?:@import\s+|@)(~\/[^\s`]+|\.{0,2}\/[^\s`]+|[A-Za-z0-9._/-]+\.(?:md|markdown|txt))\s*$/i.exec(
          line,
        );

      if (!standaloneMatch) {
        out.push(line);
        continue;
      }

      const rawRef = standaloneMatch[1].replace(/[),.;:]+$/, '');
      const candidatePath = rawRef.startsWith('~/')
        ? expandHome(rawRef)
        : path.resolve(path.dirname(currentFile), rawRef);

      if (!fs.existsSync(candidatePath)) {
        out.push(line);
        continue;
      }

      let st: fs.Stats;
      try {
        st = fs.statSync(candidatePath);
        if (!st.isFile()) {
          out.push(line);
          continue;
        }
      } catch {
        out.push(line);
        continue;
      }

      const realTarget = safeRealpath(candidatePath);
      if (stack.has(realTarget)) {
        continue; // cycle protection
      }

      if (deduplicateNativeAgentsMd && isNativeAntigravityRuleInWorkspace(realTarget, workspaceRoots)) {
        skippedDuplicateAgentsMd.push(realTarget);
        out.push(
          `<!-- [unified-memory] skipped duplicate @${rawRef} (already natively loaded by Antigravity) -->`,
        );
        continue;
      }

      imports.push(realTarget);
      const nextStack = new Set(stack);
      nextStack.add(realTarget);
      const importedRaw = fs.readFileSync(realTarget, 'utf8');
      const expandedChild = processText(importedRaw, realTarget, depth + 1, nextStack);
      out.push(`\n<!-- imported from ${rawRef} -->\n${expandedChild}\n<!-- end import ${rawRef} -->\n`);
    }

    return out.join('\n');
  }

  const rootReal = safeRealpath(sourceFilePath);
  const initialStack = new Set<string>([rootReal]);
  const content = processText(rawContent, sourceFilePath, 0, initialStack);

  return { content, imports, skippedDuplicateAgentsMd };
}

/**
 * Recursively discovers `.md` files under a `.claude/rules/` directory,
 * following symlinks with circular-symlink protection.
 */
export function walkRulesDirectory(rulesDir: string): string[] {
  if (!fs.existsSync(rulesDir)) return [];
  const visitedDirs = new Set<string>();
  const files: string[] = [];

  function visit(dir: string): void {
    const realDir = safeRealpath(dir);
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath); // follows symlinks
      } catch {
        continue; // broken symlink
      }

      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  visit(rulesDir);
  return files;
}

function isExcludedPath(
  filePath: string,
  workspaceRoot: string | undefined,
  excludes: string[],
): boolean {
  if (excludes.length === 0) return false;
  const candidates = [filePath.replace(/\\/g, '/')];
  if (workspaceRoot) {
    const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    if (!rel.startsWith('..')) {
      candidates.push(rel);
    }
  }
  return candidates.some((c) => matchesGlobPatterns(c, excludes));
}

function loadSingleRuleFile(
  filePath: string,
  scope: ClaudeRuleScope,
  options: {
    workspaceRoot?: string;
    workspaceRoots: string[];
    deduplicateNativeAgentsMd: boolean;
    parsePathsFrontmatter: boolean;
  },
): ClaudeRuleEntry | null {
  if (!fs.existsSync(filePath)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let body = raw;
  let pathsList: string[] | null = null;

  if (options.parsePathsFrontmatter) {
    const parsed = parseFrontmatter(raw);
    if (parsed.hasFrontmatter && !parsed.parseError) {
      body = parsed.body;
      const rawPaths = parsed.data.paths;
      if (Array.isArray(rawPaths)) {
        const clean = rawPaths
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map((p) => p.trim());
        if (clean.length > 0) pathsList = clean;
      } else if (typeof rawPaths === 'string' && rawPaths.trim()) {
        pathsList = rawPaths
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    // If YAML parse failed, Claude Code gracefully falls back to always-on rule!
  }

  const expanded = expandAtImports(body, filePath, {
    workspaceRoots: options.workspaceRoots,
    deduplicateNativeAgentsMd: options.deduplicateNativeAgentsMd,
  });
  const cleaned = stripHtmlComments(expanded.content);
  if (!cleaned.trim()) return null;

  const displayPath = options.workspaceRoot
    ? path.relative(options.workspaceRoot, filePath) || path.basename(filePath)
    : filePath.replace(os.homedir(), '~');

  return {
    id: safeRealpath(filePath),
    filePath: path.resolve(filePath),
    displayPath,
    scope,
    workspaceRoot: options.workspaceRoot,
    paths: pathsList,
    isConditional: pathsList !== null && pathsList.length > 0,
    content: cleaned,
    imports: expanded.imports,
    skippedDuplicateAgentsMd: expanded.skippedDuplicateAgentsMd,
    sizeBytes: Buffer.byteLength(cleaned, 'utf8'),
    mtimeMs: st.mtimeMs,
  };
}

export function getManagedClaudeMdPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  }
  if (platform === 'win32') {
    return 'C:\\ProgramData\\ClaudeCode\\CLAUDE.md';
  }
  return '/etc/claude-code/CLAUDE.md';
}

/**
 * Loads global (managed + user) and per-workspace CLAUDE.md + `.claude/rules/`
 * in exact Claude Code precedence order (broadest -> narrowest).
 */
export function loadClaudeRulesForWorkspaces(
  workspacePaths: string[],
  options?: {
    claudeConfigDir?: string;
    deduplicateNativeAgentsMd?: boolean;
    platform?: NodeJS.Platform;
  },
): {
  globalAlwaysOn: ClaudeRuleEntry[];
  globalConditional: ClaudeRuleEntry[];
  workspaces: WorkspaceRulesBundle[];
} {
  const claudeConfigDir = options?.claudeConfigDir ?? getClaudeConfigDir();
  const deduplicateNativeAgentsMd = options?.deduplicateNativeAgentsMd ?? true;
  const seenGlobalIds = new Set<string>();
  const globalAlwaysOn: ClaudeRuleEntry[] = [];
  const globalConditional: ClaudeRuleEntry[] = [];

  const userSettings = readClaudeSettings(undefined, claudeConfigDir);
  const globalExcludes = userSettings.claudeMdExcludes;

  const pushGlobal = (entry: ClaudeRuleEntry | null) => {
    if (!entry || seenGlobalIds.has(entry.id)) return;
    seenGlobalIds.add(entry.id);
    if (entry.isConditional) {
      globalConditional.push(entry);
    } else {
      globalAlwaysOn.push(entry);
    }
  };

  // 1. Managed CLAUDE.md
  const managedPath = getManagedClaudeMdPath(options?.platform);
  if (!isExcludedPath(managedPath, undefined, globalExcludes)) {
    pushGlobal(
      loadSingleRuleFile(managedPath, 'managed', {
        workspaceRoots: workspacePaths,
        deduplicateNativeAgentsMd,
        parsePathsFrontmatter: false,
      }),
    );
  }

  // 2. User ~/.claude/CLAUDE.md
  const userClaudeMd = path.join(claudeConfigDir, 'CLAUDE.md');
  if (!isExcludedPath(userClaudeMd, undefined, globalExcludes)) {
    pushGlobal(
      loadSingleRuleFile(userClaudeMd, 'user', {
        workspaceRoots: workspacePaths,
        deduplicateNativeAgentsMd,
        parsePathsFrontmatter: false,
      }),
    );
  }

  // 3. User ~/.claude/rules/**/*.md
  const userRulesDir = path.join(claudeConfigDir, 'rules');
  for (const ruleFile of walkRulesDirectory(userRulesDir)) {
    if (isExcludedPath(ruleFile, undefined, globalExcludes)) continue;
    pushGlobal(
      loadSingleRuleFile(ruleFile, 'user_rule', {
        workspaceRoots: workspacePaths,
        deduplicateNativeAgentsMd,
        parsePathsFrontmatter: true,
      }),
    );
  }

  // 4. Per-workspace bundles (supports Antigravity multi-root workspaces!)
  const workspaces: WorkspaceRulesBundle[] = [];

  for (const rawWs of workspacePaths) {
    if (!rawWs || !fs.existsSync(rawWs)) continue;
    const wsRoot = path.resolve(rawWs);
    const wsSettings = readClaudeSettings(wsRoot, claudeConfigDir);
    const excludes = wsSettings.claudeMdExcludes;
    const seenWs = new Set<string>(seenGlobalIds);
    const alwaysOn: ClaudeRuleEntry[] = [];
    const conditional: ClaudeRuleEntry[] = [];
    const excludedPaths: string[] = [];

    const addWsEntry = (
      filePath: string,
      scope: ClaudeRuleScope,
      parsePathsFrontmatter: boolean,
    ) => {
      if (!fs.existsSync(filePath)) return;
      if (isExcludedPath(filePath, wsRoot, excludes)) {
        excludedPaths.push(filePath);
        return;
      }
      const entry = loadSingleRuleFile(filePath, scope, {
        workspaceRoot: wsRoot,
        workspaceRoots: workspacePaths,
        deduplicateNativeAgentsMd,
        parsePathsFrontmatter,
      });
      if (!entry || seenWs.has(entry.id)) return;
      seenWs.add(entry.id);
      if (entry.isConditional) {
        conditional.push(entry);
      } else {
        alwaysOn.push(entry);
      }
    };

    // Walk ancestors above wsRoot (from filesystem root down to parent of wsRoot)
    const ancestors: string[] = [];
    let cur = path.dirname(wsRoot);
    while (cur && cur !== path.dirname(cur)) {
      ancestors.unshift(cur);
      cur = path.dirname(cur);
    }
    const homeDir = os.homedir();
    for (const anc of ancestors) {
      // Avoid re-loading ~/.claude/CLAUDE.md as ancestor when walking through home
      if (anc === homeDir) {
        addWsEntry(path.join(anc, 'CLAUDE.md'), 'ancestor', false);
        continue;
      }
      addWsEntry(path.join(anc, 'CLAUDE.md'), 'ancestor', false);
      addWsEntry(path.join(anc, '.claude', 'CLAUDE.md'), 'ancestor', false);
    }

    // Project root CLAUDE.md -> .claude/CLAUDE.md -> .claude/rules/**/*.md -> CLAUDE.local.md
    addWsEntry(path.join(wsRoot, 'CLAUDE.md'), 'project', false);
    addWsEntry(path.join(wsRoot, '.claude', 'CLAUDE.md'), 'project', false);

    const projRulesDir = path.join(wsRoot, '.claude', 'rules');
    for (const ruleFile of walkRulesDirectory(projRulesDir)) {
      addWsEntry(ruleFile, 'project_rule', true);
    }

    addWsEntry(path.join(wsRoot, 'CLAUDE.local.md'), 'local', false);

    workspaces.push({
      workspaceRoot: wsRoot,
      alwaysOn,
      conditional,
      excludedPaths,
    });
  }

  return { globalAlwaysOn, globalConditional, workspaces };
}

/**
 * Discovers lazy-loaded subdirectory CLAUDE.md files between an accessed file's
 * parent directory and its containing workspaceRoot (exclusive of workspaceRoot itself).
 */
export function findSubdirectoryClaudeMds(
  accessedFilePath: string,
  workspaceRoot: string,
  options?: {
    claudeConfigDir?: string;
    deduplicateNativeAgentsMd?: boolean;
  },
): ClaudeRuleEntry[] {
  const absFile = path.resolve(accessedFilePath);
  const absWs = path.resolve(workspaceRoot);
  if (absFile !== absWs && !absFile.startsWith(absWs + path.sep)) {
    return [];
  }

  const claudeConfigDir = options?.claudeConfigDir ?? getClaudeConfigDir();
  const wsSettings = readClaudeSettings(absWs, claudeConfigDir);
  const excludes = wsSettings.claudeMdExcludes;

  const dirs: string[] = [];
  let cur = path.dirname(absFile);
  while (cur.length > absWs.length && cur.startsWith(absWs + path.sep)) {
    dirs.unshift(cur); // parent-to-child order
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const results: ClaudeRuleEntry[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const candidate of [
      path.join(dir, 'CLAUDE.md'),
      path.join(dir, '.claude', 'CLAUDE.md'),
      path.join(dir, 'CLAUDE.local.md'),
    ]) {
      if (!fs.existsSync(candidate)) continue;
      if (isExcludedPath(candidate, absWs, excludes)) continue;
      const entry = loadSingleRuleFile(candidate, 'subdir', {
        workspaceRoot: absWs,
        workspaceRoots: [absWs],
        deduplicateNativeAgentsMd: options?.deduplicateNativeAgentsMd ?? true,
        parsePathsFrontmatter: false,
      });
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        results.push(entry);
      }
    }
  }

  return results;
}

export function loadConditionalRuleContent(
  ruleFilePath: string,
  workspaceRoot: string,
  scope: ClaudeRuleScope,
  options?: { deduplicateNativeAgentsMd?: boolean },
): ClaudeRuleEntry | null {
  return loadSingleRuleFile(ruleFilePath, scope, {
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    deduplicateNativeAgentsMd: options?.deduplicateNativeAgentsMd ?? true,
    parsePathsFrontmatter: true,
  });
}
