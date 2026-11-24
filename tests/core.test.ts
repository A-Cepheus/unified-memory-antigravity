import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  deleteTopicMemory,
  encodeClaudeProjectSlug,
  expandAtImports,
  extractTopicMetadata,
  findSubdirectoryClaudeMds,
  getCodexMemoryStatus,
  listTopicMemories,
  loadClaudeRulesForWorkspaces,
  matchesGlobPatterns,
  parseFrontmatter,
  readCodexMemoryFile,
  readCodexSummary,
  readMemoryIndex,
  resolveClaudeProject,
  saveTopicMemory,
  searchCodexMemories,
  stripCodexVersionHeader,
  stripHtmlComments,
  truncateMemoryIndex,
} from '../src/core/index.js';

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Claude Code path encoding & Git worktree resolution', () => {
  it('encodes slashes, dots, underscores, and spaces 1-to-1 as hyphens', () => {
    assert.equal(
      encodeClaudeProjectSlug('/Users/alice/Workspace/Acme.v2_App_Service'),
      '-Users-alice-Workspace-Acme-v2-App-Service',
    );
    assert.equal(
      encodeClaudeProjectSlug('/Users/alice/Library/Application Support/Demo App/Probe'),
      '-Users-alice-Library-Application-Support-Demo-App-Probe',
    );
  });

  it('truncates paths exceeding 200 chars with deterministic hash suffix', () => {
    const longPath = '/Users/test/' + 'segment_'.repeat(35) + 'proj';
    const slug1 = encodeClaudeProjectSlug(longPath);
    const slug2 = encodeClaudeProjectSlug(longPath);
    assert.equal(slug1, slug2);
    assert.ok(slug1.length > 200 && slug1.length < 220);
    assert.notEqual(slug1, encodeClaudeProjectSlug(longPath + '2'));
  });

  it('resolves a linked git worktree back to its main repository root', () => {
    const root = mkTempDir('um-wt-');
    try {
      const mainRepo = path.join(root, 'main-repo');
      const linkedWt = path.join(root, 'linked-wt');
      const fakeClaude = path.join(root, '.claude');
      fs.mkdirSync(mainRepo, { recursive: true });
      fs.mkdirSync(fakeClaude, { recursive: true });

      execFileSync('git', ['init', '-b', 'main'], { cwd: mainRepo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
      fs.writeFileSync(path.join(mainRepo, 'README.md'), '# main\n');
      execFileSync('git', ['add', '.'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: mainRepo, stdio: 'ignore' });
      execFileSync('git', ['worktree', 'add', '-b', 'feat-1', linkedWt], {
        cwd: mainRepo,
        stdio: 'ignore',
      });

      const mainRes = resolveClaudeProject(mainRepo, { claudeConfigDir: fakeClaude, env: {} });
      const wtRes = resolveClaudeProject(linkedWt, { claudeConfigDir: fakeClaude, env: {} });

      assert.equal(wtRes.isGitWorktree, true);
      assert.equal(fs.realpathSync(wtRes.resolvedRoot), fs.realpathSync(mainRes.resolvedRoot));
      assert.equal(wtRes.slug, mainRes.slug);
      assert.equal(wtRes.memoryDir, mainRes.memoryDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Claude Code v2.1.x & legacy frontmatter + atomic CRUD', () => {
  it('parses both legacy flat and v2.1.x nested metadata schemas', () => {
    const flat = parseFrontmatter(
      `---\nname: legacy-note\ndescription: Old flat format\ntype: feedback\noriginSessionId: sess-1\n---\n\nBody text\n`,
    );
    const flatMeta = extractTopicMetadata(flat);
    assert.equal(flatMeta.schema, 'flat');
    assert.equal(flatMeta.type, 'feedback');
    assert.equal(flatMeta.originSessionId, 'sess-1');

    const nested = parseFrontmatter(
      `---\nname: v2-note\ndescription: New nested metadata format\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: sess-2\n  modified: 2026-09-24T01:16:55.436Z\n---\n\nNested body\n`,
    );
    const nestedMeta = extractTopicMetadata(nested);
    assert.equal(nestedMeta.schema, 'nested_metadata');
    assert.equal(nestedMeta.nodeType, 'memory');
    assert.equal(nestedMeta.type, 'project');
    assert.equal(nestedMeta.modified, '2026-09-24T01:16:55.436Z');
  });

  it('writes v2.1.x nested metadata, syncs MEMORY.md preserving ref links, and deletes cleanly', () => {
    const dir = mkTempDir('um-mem-');
    try {
      const memDir = path.join(dir, 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(
        path.join(memDir, 'MEMORY.md'),
        '# Memory Index\n\n- [Existing](existing.md) — kept intact\n\n[ref-doc]: https://example.com\n',
      );

      const saved = saveTopicMemory(memDir, {
        name: 'No Mock DB Tests',
        description: 'Always run integration tests against real SQLite',
        type: 'feedback',
        body: 'User prefers real DB instances in integration tests.',
        originSessionId: 'conv-123',
      });

      assert.equal(saved.topic.schema, 'nested_metadata');
      assert.equal(saved.topic.nodeType, 'memory');
      assert.equal(saved.topic.type, 'feedback');
      assert.equal(saved.topic.originSessionId, 'conv-123');
      assert.ok(saved.topic.modified && saved.topic.modified.endsWith('Z'));
      assert.equal(saved.topic.filename, 'no-mock-db-tests.md');

      const idx = readMemoryIndex(memDir);
      assert.ok(idx.content.includes('(existing.md)'));
      assert.ok(idx.content.includes('(no-mock-db-tests.md)'));
      assert.ok(idx.content.includes('[ref-doc]: https://example.com'));

      // Update preserves originSessionId and updates index line in place without duplicating
      saveTopicMemory(memDir, {
        filename: 'no-mock-db-tests.md',
        name: 'No Mock DB Tests',
        description: 'Updated description',
        type: 'feedback',
        body: 'Updated body',
      });
      const idx2 = readMemoryIndex(memDir);
      const matches = idx2.content.match(/no-mock-db-tests\.md/g) ?? [];
      assert.equal(matches.length, 1);
      assert.ok(idx2.content.includes('Updated description'));

      // Delete removes topic and index entry cleanly
      const del = deleteTopicMemory(memDir, 'no-mock-db-tests.md');
      assert.equal(del.deleted, true);
      assert.equal(listTopicMemories(memDir).length, 0);
      assert.ok(!del.index.content.includes('no-mock-db-tests.md'));
      assert.ok(del.index.content.includes('(existing.md)'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates MEMORY.md strictly at 200 lines or 25 KB (whichever comes first)', () => {
    const lines250 = Array.from({ length: 250 }, (_, i) => `- item ${i + 1}`).join('\n');
    const byLine = truncateMemoryIndex(lines250);
    assert.equal(byLine.truncated, true);
    assert.equal(byLine.includedLines, 200);
    assert.equal(byLine.totalLines, 250);

    const bigLines = Array.from({ length: 50 }, (_, i) => `- ${i}: ${'x'.repeat(1000)}`).join('\n');
    const byByte = truncateMemoryIndex(bigLines);
    assert.equal(byByte.truncated, true);
    assert.ok(byByte.includedBytes <= 25 * 1024);
    assert.ok(byByte.includedLines < 50);
  });
});

describe('CLAUDE.md & .claude/rules loading, @imports, comments, globs, and subdirs', () => {
  it('strips HTML comments outside code fences & inline code', () => {
    const md = [
      'Visible line <!-- hidden inline --> end',
      '<!--',
      'hidden multiline',
      '-->',
      '```html',
      '<!-- keep inside code fence -->',
      '```',
      'Keep `<!-- inside backticks -->` too',
    ].join('\n');
    const cleaned = stripHtmlComments(md);
    assert.ok(!cleaned.includes('hidden inline'));
    assert.ok(!cleaned.includes('hidden multiline'));
    assert.ok(cleaned.includes('<!-- keep inside code fence -->'));
    assert.ok(cleaned.includes('`<!-- inside backticks -->`'));
  });

  it('matches globs with ** and brace expansion {ts,tsx}', () => {
    assert.equal(matchesGlobPatterns('src/api/v1/users.ts', ['src/api/**/*.{ts,tsx}']), true);
    assert.equal(matchesGlobPatterns('src/api/users.tsx', ['src/api/**/*.{ts,tsx}']), true);
    assert.equal(matchesGlobPatterns('src/api/users.py', ['src/api/**/*.{ts,tsx}']), false);
  });

  it('loads workspace CLAUDE.md, expands @imports, dedupes AGENTS.md, separates paths rules, and finds subdir CLAUDE.md', () => {
    const root = mkTempDir('um-rules-');
    try {
      const fakeClaude = path.join(root, '.claude-global');
      const ws = path.join(root, 'repo');
      fs.mkdirSync(path.join(fakeClaude, 'rules'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.claude', 'rules', 'backend'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'packages', 'api'), { recursive: true });

      fs.writeFileSync(path.join(fakeClaude, 'CLAUDE.md'), 'GLOBAL_CLAUDE_RULE\n');
      fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'NATIVE_AGENTS_MD\n');
      fs.writeFileSync(path.join(ws, 'extra.md'), 'IMPORTED_EXTRA_MD\n');
      fs.writeFileSync(
        path.join(ws, 'CLAUDE.md'),
        '# Root\n@AGENTS.md\n@extra.md\n<!-- comment -->\nROOT_RULE\n',
      );
      fs.writeFileSync(path.join(ws, 'CLAUDE.local.md'), 'LOCAL_OVERRIDE_RULE\n');
      fs.writeFileSync(
        path.join(ws, '.claude', 'rules', 'always.md'),
        'ALWAYS_ON_PROJECT_RULE\n',
      );
      fs.writeFileSync(
        path.join(ws, '.claude', 'rules', 'backend', 'api.md'),
        '---\npaths:\n  - "packages/api/**/*.{ts,tsx}"\n---\nSCOPED_API_RULE\n',
      );
      fs.writeFileSync(
        path.join(ws, 'packages', 'api', 'CLAUDE.md'),
        'SUBDIR_API_CLAUDE_MD\n',
      );

      const loaded = loadClaudeRulesForWorkspaces([ws], {
        claudeConfigDir: fakeClaude,
        deduplicateNativeAgentsMd: true,
      });

      assert.equal(loaded.globalAlwaysOn.length, 1);
      assert.equal(loaded.workspaces.length, 1);

      const bundle = loaded.workspaces[0];
      const combinedAlways = bundle.alwaysOn.map((r) => r.content).join('\n');
      assert.ok(combinedAlways.includes('ROOT_RULE'));
      assert.ok(combinedAlways.includes('IMPORTED_EXTRA_MD'));
      assert.ok(combinedAlways.includes('ALWAYS_ON_PROJECT_RULE'));
      assert.ok(combinedAlways.includes('LOCAL_OVERRIDE_RULE'));
      assert.ok(!combinedAlways.includes('NATIVE_AGENTS_MD')); // deduplicated!
      assert.ok(!combinedAlways.includes('SCOPED_API_RULE')); // dormant!
      assert.ok(!combinedAlways.includes('SUBDIR_API_CLAUDE_MD')); // lazy-loaded!

      assert.equal(bundle.conditional.length, 1);
      assert.deepEqual(bundle.conditional[0].paths, ['packages/api/**/*.{ts,tsx}']);

      const subdirs = findSubdirectoryClaudeMds(
        path.join(ws, 'packages', 'api', 'handler.ts'),
        ws,
        { claudeConfigDir: fakeClaude },
      );
      assert.equal(subdirs.length, 1);
      assert.ok(subdirs[0].content.includes('SUBDIR_API_CLAUDE_MD'));

      // Cycle detection test on @import
      fs.writeFileSync(path.join(ws, 'a.md'), '@b.md\nA_BODY\n');
      fs.writeFileSync(path.join(ws, 'b.md'), '@a.md\nB_BODY\n');
      const exp = expandAtImports('@b.md\nA_BODY\n', path.join(ws, 'a.md'));
      assert.ok(exp.content.includes('B_BODY'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Codex CLI read-only memory adapter (memories_v2 + v1 + path jail)', () => {
  it('prefers memories_v2, strips v1 header, searches across v2+v1, and blocks disallowed paths', () => {
    const root = mkTempDir('um-codex-');
    try {
      fs.mkdirSync(path.join(root, 'memories_v2', 'rollout_summaries'), { recursive: true });
      fs.mkdirSync(path.join(root, 'memories_v2', 'extensions', 'ad_hoc'), { recursive: true });
      fs.mkdirSync(path.join(root, 'memories'), { recursive: true });

      fs.writeFileSync(
        path.join(root, 'config.toml'),
        '[features]\nmemories = true\n\n[memories]\ngenerate_memories = true\nuse_memories = true\n',
      );
      fs.writeFileSync(
        path.join(root, 'memories', 'memory_summary.md'),
        'v1\n\n## User Profile\nOld v1 summary\n',
      );
      fs.writeFileSync(
        path.join(root, 'memories', 'MEMORY.md'),
        '# Handbook\n\n## Unified Memory Notes\nUse flock for atomic updates.\n',
      );
      fs.writeFileSync(
        path.join(root, 'memories_v2', 'memory_summary.md'),
        'v1\n\n## User Profile\nFresh v2 summary\n',
      );
      fs.writeFileSync(
        path.join(root, 'memories_v2', 'rollout_summaries', '2026-11-24-auth-fix.md'),
        '# Auth Fix\nResolved token refresh race condition in my-app.\n',
      );
      fs.writeFileSync(
        path.join(root, 'memories_v2', 'extensions', 'ad_hoc', 'instructions.md'),
        'Always double-check release tags.\n',
      );

      const status = getCodexMemoryStatus(root);
      assert.equal(status.activeGeneration, 'v2');
      assert.equal(status.configFlags.featuresMemories, true);
      assert.equal(status.configFlags.useMemories, true);
      assert.equal(status.v2.rolloutCount, 1);
      assert.deepEqual(status.v2.extensionFiles, ['extensions/ad_hoc/instructions.md']);

      const sum = readCodexSummary({ codexHome: root });
      assert.equal(sum.generation, 'v2');
      assert.ok(sum.content.startsWith('## User Profile'));
      assert.ok(!sum.content.startsWith('v1'));
      assert.equal(stripCodexVersionHeader('v1\n\nHello'), 'Hello');

      const hits = searchCodexMemories('token refresh', { codexHome: root, projectHint: 'my-app' });
      assert.ok(hits.length >= 1);
      assert.equal(hits[0].generation, 'v2');
      assert.equal(hits[0].category, 'rollout');

      // Security path jail checks
      assert.throws(() => readCodexMemoryFile('v2', '../config.toml', root));
      assert.throws(() => readCodexMemoryFile('v1', 'raw_memories.md', root));
      assert.throws(() => readCodexMemoryFile('v2', '.git/HEAD', root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
