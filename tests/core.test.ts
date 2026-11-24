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
  findSubdirectoryClaudeMdsWithDiagnostics,
  getCodexMemoryStatus,
  listTopicMemories,
  loadClaudeRulesForWorkspaces,
  loadConditionalRuleContentWithDiagnostics,
  matchesGlobPatterns,
  parseFrontmatter,
  readClaudeCodeExternalApproval,
  readCodexMemoryFile,
  readCodexSummary,
  readMemoryIndex,
  resolveClaudeProject,
  saveTopicMemory,
  searchCodexMemories,
  stripCodexVersionHeader,
  stripHtmlComments,
  truncateMemoryIndex,
  updateWorkspaceExternalTrust,
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

  it('enforces external @import and rule symlink trust for repo rules while trusting user-level rules', () => {
    const root = mkTempDir('um-ext-trust-');
    try {
      const fakeClaude = path.join(root, '.claude-global');
      const extDir = path.join(root, 'external-notes');
      const otherExtDir = path.join(root, 'other-secret');
      const wsA = path.join(root, 'repo-a');
      const wsB = path.join(root, 'repo-b');
      const pluginData = path.join(root, 'plugin-data');

      fs.mkdirSync(path.join(fakeClaude, 'rules'), { recursive: true });
      fs.mkdirSync(extDir, { recursive: true });
      fs.mkdirSync(otherExtDir, { recursive: true });
      fs.mkdirSync(path.join(wsA, '.claude', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(wsA, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(wsA, 'subpkg'), { recursive: true });
      fs.mkdirSync(wsB, { recursive: true });

      const styleFile = path.join(extDir, 'writing-style.md');
      const sharedRuleFile = path.join(extDir, 'shared-rule.md');
      const userExtRuleFile = path.join(otherExtDir, 'user-only-rule.md');
      const secretFile = path.join(otherExtDir, 'secret.md');
      fs.writeFileSync(styleFile, 'EXT_STYLE_CONTENT\n');
      fs.writeFileSync(sharedRuleFile, 'EXT_SHARED_RULE_CONTENT\n');
      fs.writeFileSync(userExtRuleFile, 'USER_EXT_SYMLINK_CONTENT\n');
      fs.writeFileSync(secretFile, 'EXT_SECRET_CONTENT\n');
      // Escape symlink inside external shared dir pointing to a different unapproved dir
      fs.symlinkSync(secretFile, path.join(extDir, 'escape.md'));

      // User-level rules (trusted by default)
      fs.writeFileSync(path.join(fakeClaude, 'CLAUDE.md'), `@${styleFile}\nUSER_OWN_RULE\n`);
      fs.symlinkSync(userExtRuleFile, path.join(fakeClaude, 'rules', 'user-ext-link.md'));
      fs.writeFileSync(
        path.join(fakeClaude, 'rules', 'user-scoped.md'),
        `---\npaths:\n  - "subpkg/**/*.ts"\n---\n@${styleFile}\nUSER_SCOPED_OK\n`,
      );

      // Repo A: intra-workspace safe links + untrusted external imports/symlinks
      fs.writeFileSync(path.join(wsA, 'docs', 'inner.md'), `@${secretFile}\nINNER_DOC_BODY\n`);
      fs.writeFileSync(path.join(wsA, 'docs', 'local-rule.md'), 'INTRA_WS_SYMLINK_RULE\n');
      fs.symlinkSync(secretFile, path.join(wsA, 'docs', 'sym-to-secret.md'));
      fs.writeFileSync(
        path.join(wsA, 'CLAUDE.md'),
        [
          '# Repo A',
          `@${styleFile}`,
          '@docs/inner.md',
          '@docs/sym-to-secret.md',
          '@/components/Button', // non-existent TS alias must not false-positive
          'REPO_A_SAFE_BODY',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(path.join(wsA, 'CLAUDE.local.md'), `@${secretFile}\nLOCAL_SAFE_BODY\n`);
      fs.symlinkSync(
        path.join(wsA, 'docs', 'local-rule.md'),
        path.join(wsA, '.claude', 'rules', 'intra-link.md'),
      );
      fs.symlinkSync(sharedRuleFile, path.join(wsA, '.claude', 'rules', 'ext-link.md'));
      fs.symlinkSync(extDir, path.join(wsA, '.claude', 'rules', 'ext-dir'));
      fs.writeFileSync(path.join(wsA, 'subpkg', 'CLAUDE.md'), `@${secretFile}\nSUBPKG_SAFE\n`);
      fs.writeFileSync(path.join(wsA, 'subpkg', 'app.ts'), 'export const a = 1;\n');

      // Repo B tries cross-workspace import into Repo A
      fs.writeFileSync(path.join(wsA, 'private.md'), 'WS_A_PRIVATE_CONTENT\n');
      fs.writeFileSync(path.join(wsB, 'CLAUDE.md'), `@../repo-a/private.md\nREPO_B_BODY\n`);

      // 1. Default fail-closed check
      const initial = loadClaudeRulesForWorkspaces([wsA, wsB], {
        claudeConfigDir: fakeClaude,
        deduplicateNativeAgentsMd: true,
      });

      // User-level rules MUST expand external imports & symlinks automatically
      const globalText = initial.globalAlwaysOn.map((r) => r.content).join('\n');
      assert.ok(globalText.includes('EXT_STYLE_CONTENT'));
      assert.ok(globalText.includes('USER_EXT_SYMLINK_CONTENT'));
      assert.equal(initial.globalConditional.length, 1);
      assert.ok(initial.globalConditional[0].content.includes('EXT_STYLE_CONTENT'));

      // Lazy load of user_rule MUST keep trusted scope
      const lazyUser = loadConditionalRuleContentWithDiagnostics(
        path.join(fakeClaude, 'rules', 'user-scoped.md'),
        wsA,
        'user_rule',
        { claudeConfigDir: fakeClaude },
      );
      assert.ok(lazyUser.entry?.content.includes('EXT_STYLE_CONTENT'));
      assert.equal(lazyUser.blocked.length, 0);

      // Repo A MUST block all external targets while allowing intra-workspace symlinks & normal docs
      const bundleA = initial.workspaces.find((w) => w.workspaceRoot === path.resolve(wsA))!;
      const repoAText = bundleA.alwaysOn.map((r) => r.content).join('\n');
      assert.ok(repoAText.includes('REPO_A_SAFE_BODY'));
      assert.ok(repoAText.includes('INNER_DOC_BODY'));
      assert.ok(repoAText.includes('INTRA_WS_SYMLINK_RULE'));
      assert.ok(repoAText.includes('LOCAL_SAFE_BODY'));
      assert.ok(repoAText.includes('@/components/Button')); // untouched non-existent alias
      assert.ok(!repoAText.includes('EXT_STYLE_CONTENT'));
      assert.ok(!repoAText.includes('EXT_SHARED_RULE_CONTENT'));
      assert.ok(!repoAText.includes('EXT_SECRET_CONTENT'));

      assert.ok(
        bundleA.blockedExternalTargets.some(
          (b) => b.kind === 'external_import' && b.resolvedTarget === fs.realpathSync(styleFile),
        ),
      );
      assert.ok(
        bundleA.blockedExternalTargets.some(
          (b) => b.kind === 'external_import' && b.resolvedTarget === fs.realpathSync(secretFile),
        ),
      );
      assert.ok(
        bundleA.blockedExternalTargets.some(
          (b) =>
            b.kind === 'external_rule_symlink' &&
            b.resolvedTarget === fs.realpathSync(sharedRuleFile),
        ),
      );
      assert.ok(
        bundleA.blockedExternalTargets.some(
          (b) =>
            b.kind === 'external_rule_dir_symlink' &&
            b.targetIsDir === true &&
            b.resolvedTarget === fs.realpathSync(extDir),
        ),
      );
      // Non-existent TS alias must not appear in blocked list
      assert.ok(!bundleA.blockedExternalTargets.some((b) => b.rawRef === '/components/Button'));

      // Repo B MUST NOT read Repo A's private file (strict per-workspace boundary in multi-root)
      const bundleB = initial.workspaces.find((w) => w.workspaceRoot === path.resolve(wsB))!;
      const repoBText = bundleB.alwaysOn.map((r) => r.content).join('\n');
      assert.ok(repoBText.includes('REPO_B_BODY'));
      assert.ok(!repoBText.includes('WS_A_PRIVATE_CONTENT'));
      assert.equal(bundleB.blockedExternalTargets.length, 1);

      // Subdir CLAUDE.md MUST also block external imports
      const subRes = findSubdirectoryClaudeMdsWithDiagnostics(
        path.join(wsA, 'subpkg', 'app.ts'),
        wsA,
        { claudeConfigDir: fakeClaude },
      );
      assert.equal(subRes.entries.length, 1);
      assert.ok(subRes.entries[0].content.includes('SUBPKG_SAFE'));
      assert.ok(!subRes.entries[0].content.includes('EXT_SECRET_CONTENT'));
      assert.equal(subRes.blocked.length, 1);

      // 2. Target-scoped plugin allowlist approves ONLY the exact approved file (no Day-2 drift)
      const afterFileAllow = updateWorkspaceExternalTrust(wsA, 'allow', styleFile, pluginData);
      const loadedFileAllow = loadClaudeRulesForWorkspaces([wsA], {
        claudeConfigDir: fakeClaude,
        externalRuleTrust: afterFileAllow.config.externalRuleTrust,
      });
      const textAfterFileAllow = loadedFileAllow.workspaces[0].alwaysOn
        .map((r) => r.content)
        .join('\n');
      assert.ok(textAfterFileAllow.includes('EXT_STYLE_CONTENT'));
      assert.ok(!textAfterFileAllow.includes('EXT_SHARED_RULE_CONTENT'));
      assert.ok(!textAfterFileAllow.includes('EXT_SECRET_CONTENT'));

      // 3. Directory prefix allowlist approves extDir symlink & files inside, but STILL blocks escape.md -> otherExtDir
      const afterDirAllow = updateWorkspaceExternalTrust(wsA, 'allow', extDir, pluginData);
      const loadedDirAllow = loadClaudeRulesForWorkspaces([wsA], {
        claudeConfigDir: fakeClaude,
        externalRuleTrust: afterDirAllow.config.externalRuleTrust,
      });
      const textAfterDirAllow = loadedDirAllow.workspaces[0].alwaysOn
        .map((r) => r.content)
        .join('\n');
      assert.ok(textAfterDirAllow.includes('EXT_STYLE_CONTENT'));
      assert.ok(textAfterDirAllow.includes('EXT_SHARED_RULE_CONTENT'));
      assert.ok(!textAfterDirAllow.includes('EXT_SECRET_CONTENT')); // escape symlink inside extDir still blocked!

      // 4. Native Claude Code ~/.claude.json project approval interop (read-only) + plugin deny override
      const claudeStateFile = path.join(fakeClaude, '.claude.json');
      fs.writeFileSync(
        claudeStateFile,
        JSON.stringify(
          {
            projects: {
              [path.resolve(wsA)]: {
                hasClaudeMdExternalIncludesApproved: true,
                hasClaudeMdExternalIncludesWarningShown: true,
              },
              [path.resolve(wsB)]: {
                hasClaudeMdExternalIncludesApproved: false,
                hasClaudeMdExternalIncludesWarningShown: true,
              },
            },
          },
          null,
          2,
        ),
      );
      const ccStateA = readClaudeCodeExternalApproval(wsA, { claudeConfigDir: fakeClaude });
      assert.equal(ccStateA?.approved, true);

      // With Claude Code approval active, Repo A loads all external targets without plugin allowlist
      const loadedCcApproved = loadClaudeRulesForWorkspaces([wsA, wsB], {
        claudeConfigDir: fakeClaude,
        trustClaudeCodeExternalApprovals: true,
      });
      const ccTextA = loadedCcApproved.workspaces[0].alwaysOn.map((r) => r.content).join('\n');
      assert.ok(ccTextA.includes('EXT_STYLE_CONTENT'));
      assert.ok(ccTextA.includes('EXT_SECRET_CONTENT'));
      assert.equal(loadedCcApproved.workspaces[0].blockedExternalTargets.length, 0);
      // Repo B was declined in Claude Code -> status denied_by_claude_code
      assert.equal(
        loadedCcApproved.workspaces[1].blockedExternalTargets[0]?.status,
        'denied_by_claude_code',
      );

      // Disabling trustClaudeCodeExternalApprovals falls back to fail-closed
      const loadedCcDisabled = loadClaudeRulesForWorkspaces([wsA], {
        claudeConfigDir: fakeClaude,
        trustClaudeCodeExternalApprovals: false,
      });
      assert.ok(
        !loadedCcDisabled.workspaces[0].alwaysOn.map((r) => r.content).join('\n').includes('EXT_SECRET_CONTENT'),
      );

      // Explicit plugin deny overrides Claude Code project approval
      const cleared = updateWorkspaceExternalTrust(wsA, 'clear_workspace', undefined, pluginData);
      assert.equal(cleared.trust.allowPaths.length, 0);
      const afterDeny = updateWorkspaceExternalTrust(wsA, 'deny', secretFile, pluginData);
      const loadedDenyOverride = loadClaudeRulesForWorkspaces([wsA], {
        claudeConfigDir: fakeClaude,
        trustClaudeCodeExternalApprovals: true,
        externalRuleTrust: afterDeny.config.externalRuleTrust,
      });
      const denyOverrideText = loadedDenyOverride.workspaces[0].alwaysOn
        .map((r) => r.content)
        .join('\n');
      assert.ok(denyOverrideText.includes('EXT_STYLE_CONTENT'));
      assert.ok(!denyOverrideText.includes('EXT_SECRET_CONTENT'));
      assert.ok(
        loadedDenyOverride.workspaces[0].blockedExternalTargets.some(
          (b) =>
            b.resolvedTarget === fs.realpathSync(secretFile) && b.status === 'denied_by_plugin',
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks symlinked root CLAUDE.md and allows same-repo monorepo ancestor imports while blocking external ones', () => {
    const root = mkTempDir('um-monorepo-');
    try {
      const fakeClaude = path.join(root, '.claude-global');
      const outside = path.join(root, 'outside');
      const mono = path.join(root, 'monorepo');
      const appPkg = path.join(mono, 'packages', 'app');
      const symWs = path.join(root, 'sym-repo');

      fs.mkdirSync(fakeClaude, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.mkdirSync(path.join(mono, 'docs'), { recursive: true });
      fs.mkdirSync(appPkg, { recursive: true });
      fs.mkdirSync(symWs, { recursive: true });

      const extSecret = path.join(outside, 'secret.md');
      fs.writeFileSync(extSecret, 'OUTSIDE_MONO_SECRET\n');
      fs.writeFileSync(path.join(mono, 'docs', 'arch.md'), 'SAME_MONO_ARCH_DOC\n');
      fs.writeFileSync(
        path.join(mono, 'CLAUDE.md'),
        `@docs/arch.md\n@${extSecret}\nMONO_ROOT_RULE\n`,
      );
      fs.writeFileSync(path.join(appPkg, 'CLAUDE.md'), 'APP_PKG_RULE\n');

      execFileSync('git', ['init', '-b', 'main'], { cwd: mono, stdio: 'ignore' });

      // Workspace with root CLAUDE.md symlinked outside & .claude/rules symlinked outside
      fs.symlinkSync(extSecret, path.join(symWs, 'CLAUDE.md'));
      fs.mkdirSync(path.join(symWs, '.claude'), { recursive: true });
      fs.symlinkSync(outside, path.join(symWs, '.claude', 'rules'));

      const loaded = loadClaudeRulesForWorkspaces([appPkg, symWs], {
        claudeConfigDir: fakeClaude,
      });

      const monoBundle = loaded.workspaces.find((w) => w.workspaceRoot === path.resolve(appPkg))!;
      const monoText = monoBundle.alwaysOn.map((r) => r.content).join('\n');
      assert.ok(monoText.includes('SAME_MONO_ARCH_DOC'));
      assert.ok(monoText.includes('MONO_ROOT_RULE'));
      assert.ok(monoText.includes('APP_PKG_RULE'));
      assert.ok(!monoText.includes('OUTSIDE_MONO_SECRET'));
      assert.equal(monoBundle.blockedExternalTargets.length, 1);

      const symBundle = loaded.workspaces.find((w) => w.workspaceRoot === path.resolve(symWs))!;
      assert.equal(symBundle.alwaysOn.length, 0);
      assert.ok(
        symBundle.blockedExternalTargets.some(
          (b) => b.kind === 'external_rule_symlink' && b.sourceDisplayPath === 'CLAUDE.md',
        ),
      );
      assert.ok(
        symBundle.blockedExternalTargets.some(
          (b) => b.kind === 'external_rule_dir_symlink' && b.sourceDisplayPath === '.claude/rules',
        ),
      );
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
