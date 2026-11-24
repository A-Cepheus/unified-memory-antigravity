import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_MEMORY_TYPES,
  type ClaudeMemoryIndex,
  type ClaudeMemoryTopic,
  type ClaudeMemoryType,
} from '../types.js';
import {
  extractTopicMetadata,
  parseFrontmatter,
  serializeClaudeTopic,
} from './frontmatter.js';

export const MAX_MEMORY_INDEX_LINES = 200;
export const MAX_MEMORY_INDEX_BYTES = 25 * 1024; // 25,600 bytes

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 2_500;

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // brief busy wait for cross-platform synchronous lock acquisition
  }
}

export function withFileLock<T>(lockDir: string, fn: () => T): T {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, '.unified-memory.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;

      // Reclaim stale lock if owning process crashed
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for memory lock at ${lockFile}`);
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // ignore cleanup error
    }
  }
}

export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`,
  );
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Validates and sanitizes a topic filename so it stays strictly inside memoryDir.
 */
export function sanitizeTopicFilename(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Topic filename or name must not be empty');
  }
  const base = path.basename(trimmed);
  if (base !== trimmed || base.includes('..') || base.includes('/') || base.includes('\\')) {
    throw new Error(`Invalid topic filename (path traversal not allowed): ${input}`);
  }
  const withoutExt = base.replace(/\.md$/i, '');
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === 'memory') {
    throw new Error(`Invalid or reserved topic filename: ${input}`);
  }
  return `${slug}.md`;
}

export function assertInsideMemoryDir(memoryDir: string, filename: string): string {
  const base = path.basename(filename);
  if (base !== filename || base.includes('..') || !base.endsWith('.md')) {
    throw new Error(`Unsafe memory filename: ${filename}`);
  }
  const resolvedDir = path.resolve(memoryDir);
  const target = path.resolve(resolvedDir, base);
  if (path.dirname(target) !== resolvedDir) {
    throw new Error(`Path escapes memory directory: ${filename}`);
  }
  return target;
}

/**
 * Truncates MEMORY.md strictly to the first 200 lines OR 25 KB (whichever comes first),
 * matching Claude Code's Auto Memory startup loading budget.
 */
export function truncateMemoryIndex(
  content: string,
  maxLines: number = MAX_MEMORY_INDEX_LINES,
  maxBytes: number = MAX_MEMORY_INDEX_BYTES,
): {
  truncatedContent: string;
  totalLines: number;
  totalBytes: number;
  includedLines: number;
  includedBytes: number;
  truncated: boolean;
} {
  const normalized = content.replace(/\r\n/g, '\n');
  const totalBytes = Buffer.byteLength(normalized, 'utf8');
  if (normalized === '') {
    return {
      truncatedContent: '',
      totalLines: 0,
      totalBytes: 0,
      includedLines: 0,
      includedBytes: 0,
      truncated: false,
    };
  }

  const lines = normalized.split('\n');
  const totalLines = lines.length;
  const out: string[] = [];
  let bytes = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    if (i >= maxLines) {
      truncated = true;
      break;
    }
    const line = lines[i];
    const sepBytes = i > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8') + sepBytes;
    if (bytes + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }

  return {
    truncatedContent: out.join('\n'),
    totalLines,
    totalBytes,
    includedLines: out.length,
    includedBytes: bytes,
    truncated,
  };
}

export function readMemoryIndex(memoryDir: string): ClaudeMemoryIndex {
  const filePath = path.join(memoryDir, 'MEMORY.md');
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      content: '',
      truncatedContent: '',
      totalLines: 0,
      totalBytes: 0,
      includedLines: 0,
      includedBytes: 0,
      truncated: false,
      maxLines: MAX_MEMORY_INDEX_LINES,
      maxBytes: MAX_MEMORY_INDEX_BYTES,
      mtimeMs: 0,
    };
  }

  const st = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const trunc = truncateMemoryIndex(content);

  return {
    filePath,
    exists: true,
    content,
    ...trunc,
    maxLines: MAX_MEMORY_INDEX_LINES,
    maxBytes: MAX_MEMORY_INDEX_BYTES,
    mtimeMs: st.mtimeMs,
  };
}

export function readTopicMemory(memoryDir: string, filename: string): ClaudeMemoryTopic | null {
  const filePath = assertInsideMemoryDir(memoryDir, filename);
  if (!fs.existsSync(filePath)) return null;
  const st = fs.statSync(filePath);
  const rawContent = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(rawContent);
  const meta = extractTopicMetadata(parsed);

  const fallbackName = path.basename(filename, '.md');
  const lineCount =
    rawContent === '' ? 0 : rawContent.replace(/\r\n/g, '\n').split('\n').length;

  return {
    filename: path.basename(filePath),
    filePath,
    name: meta.name ?? fallbackName,
    description: meta.description ?? '',
    type: meta.type ?? 'project',
    nodeType: meta.nodeType,
    originSessionId: meta.originSessionId,
    modified: meta.modified,
    schema: meta.schema,
    body: parsed.body,
    rawContent,
    sizeBytes: st.size,
    lineCount,
    mtimeMs: st.mtimeMs,
  };
}

export function listTopicMemories(memoryDir: string): ClaudeMemoryTopic[] {
  if (!fs.existsSync(memoryDir)) return [];
  const entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  const topics: ClaudeMemoryTopic[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') {
      continue;
    }
    const topic = readTopicMemory(memoryDir, entry.name);
    if (topic) topics.push(topic);
  }
  topics.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename));
  return topics;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIndexLine(name: string, filename: string, description: string): string {
  const cleanTitle = name.replace(/[\r\n[\]]+/g, ' ').trim() || filename;
  const cleanDesc = description.replace(/[\r\n]+/g, ' ').trim();
  const clipped = cleanDesc.length > 150 ? `${cleanDesc.slice(0, 147)}...` : cleanDesc;
  return clipped ? `- [${cleanTitle}](${filename}) — ${clipped}` : `- [${cleanTitle}](${filename})`;
}

/**
 * Safely updates or inserts a topic pointer line inside MEMORY.md while
 * preserving existing sections, comments, and Markdown link reference definitions.
 */
function upsertIndexEntry(existingContent: string, filename: string, indexLine: string): string {
  const normalized = existingContent.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return `# Memory Index\n\n${indexLine}\n`;
  }

  const lines = normalized.split('\n');
  const linkPattern = new RegExp(`\\(\\.?/?${escapeRegExp(filename)}\\)`);
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    if (linkPattern.test(lines[i])) {
      lines[i] = indexLine;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Insert before trailing blank lines or trailing link-reference definitions (`[id]: url`)
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') {
      insertAt--;
    }
    while (insertAt > 0 && /^\[[^\]]+\]:\s+\S+/.test(lines[insertAt - 1].trim())) {
      insertAt--;
    }
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') {
      insertAt--;
    }
    lines.splice(insertAt, 0, indexLine);
  }

  return `${lines.join('\n').replace(/\n*$/, '\n')}`;
}

function removeIndexEntry(existingContent: string, filename: string): string {
  const normalized = existingContent.replace(/\r\n/g, '\n');
  if (!normalized) return '';
  const linkPattern = new RegExp(`\\(\\.?/?${escapeRegExp(filename)}\\)`);
  const kept = normalized.split('\n').filter((line) => !linkPattern.test(line));
  return `${kept.join('\n').replace(/\n*$/, '\n')}`;
}

export interface SaveTopicMemoryInput {
  filename?: string;
  name: string;
  description: string;
  type: ClaudeMemoryType;
  body: string;
  originSessionId?: string;
}

export interface SaveTopicMemoryResult {
  topic: ClaudeMemoryTopic;
  index: ClaudeMemoryIndex;
  warnings: string[];
}

export function saveTopicMemory(
  memoryDir: string,
  input: SaveTopicMemoryInput,
): SaveTopicMemoryResult {
  if (!CLAUDE_MEMORY_TYPES.includes(input.type)) {
    throw new Error(
      `Invalid Claude memory type "${String(input.type)}". Must be one of: ${CLAUDE_MEMORY_TYPES.join(', ')}`,
    );
  }
  const filename = sanitizeTopicFilename(input.filename || input.name);

  return withFileLock(memoryDir, () => {
    const filePath = assertInsideMemoryDir(memoryDir, filename);

    // Preserve extra keys if updating an existing topic
    let extraTopLevel: Record<string, unknown> = {};
    let extraMetadata: Record<string, string> = {};
    let preservedOriginSessionId = input.originSessionId;

    if (fs.existsSync(filePath)) {
      const existingRaw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseFrontmatter(existingRaw);
      const existingMeta = extractTopicMetadata(parsed);
      extraTopLevel = existingMeta.extraTopLevel;
      extraMetadata = existingMeta.extraMetadata;
      if (!preservedOriginSessionId && existingMeta.originSessionId) {
        preservedOriginSessionId = existingMeta.originSessionId;
      }
    }

    const serialized = serializeClaudeTopic({
      name: input.name.trim(),
      description: input.description.trim(),
      type: input.type,
      originSessionId: preservedOriginSessionId,
      modified: new Date().toISOString(),
      body: input.body,
      extraTopLevel,
      extraMetadata,
    });

    atomicWriteFile(filePath, serialized);

    const indexPath = path.join(memoryDir, 'MEMORY.md');
    const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    const line = buildIndexLine(input.name, filename, input.description);
    const updatedIndexContent = upsertIndexEntry(existingIndex, filename, line);
    atomicWriteFile(indexPath, updatedIndexContent);

    const topic = readTopicMemory(memoryDir, filename)!;
    const index = readMemoryIndex(memoryDir);
    const warnings: string[] = [];
    if (index.truncated) {
      warnings.push(
        `MEMORY.md exceeds Claude Code's 200-line / 25 KB startup limit (${index.totalLines} lines, ${(index.totalBytes / 1024).toFixed(1)} KB). Consider running memory consolidation.`,
      );
    } else if (index.totalLines >= 175 || index.totalBytes >= 22 * 1024) {
      warnings.push(
        `MEMORY.md is approaching the 200-line / 25 KB startup limit (${index.totalLines}/200 lines, ${(index.totalBytes / 1024).toFixed(1)}/25 KB).`,
      );
    }

    return { topic, index, warnings };
  });
}

export function deleteTopicMemory(
  memoryDir: string,
  filename: string,
): { deleted: boolean; index: ClaudeMemoryIndex } {
  return withFileLock(memoryDir, () => {
    const filePath = assertInsideMemoryDir(memoryDir, filename);
    let deleted = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted = true;
    }

    const indexPath = path.join(memoryDir, 'MEMORY.md');
    if (fs.existsSync(indexPath)) {
      const existingIndex = fs.readFileSync(indexPath, 'utf8');
      const updated = removeIndexEntry(existingIndex, path.basename(filePath));
      if (updated !== existingIndex) {
        atomicWriteFile(indexPath, updated);
      }
    }

    return { deleted, index: readMemoryIndex(memoryDir) };
  });
}

export function writeMemoryIndexRaw(memoryDir: string, content: string): ClaudeMemoryIndex {
  return withFileLock(memoryDir, () => {
    const indexPath = path.join(memoryDir, 'MEMORY.md');
    atomicWriteFile(indexPath, content.replace(/\r\n/g, '\n'));
    return readMemoryIndex(memoryDir);
  });
}
