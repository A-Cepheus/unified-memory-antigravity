import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOOK_BUNDLE = path.join(REPO_ROOT, 'dist', 'hook.cjs');
const MCP_BUNDLE = path.join(REPO_ROOT, 'dist', 'mcp.cjs');
const APP_HTML = path.join(REPO_ROOT, 'dist', 'app.html');

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHook(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [HOOK_BUNDLE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe('Built dist/ end-to-end verification (Hook + MCP Server + MCP App UI)', () => {
  it('verifies dist bundles exist and app.html is a self-contained single file', () => {
    assert.ok(fs.existsSync(HOOK_BUNDLE), 'dist/hook.cjs must exist');
    assert.ok(fs.existsSync(MCP_BUNDLE), 'dist/mcp.cjs must exist');
    assert.ok(fs.existsSync(APP_HTML), 'dist/app.html must exist');
    const html = fs.readFileSync(APP_HTML, 'utf8');
    assert.ok(html.includes('<script'), 'dist/app.html must inline JS');
    assert.ok(html.length < 10 * 1024 * 1024, 'dist/app.html must be < 10 MiB');
  });

  it('runs SessionStart (idempotent) -> PostToolUse -> PreInvocation lazy injection -> compaction reload', () => {
    const tmp = mkTempDir('um-e2e-hook-');
    try {
      const fakeClaude = path.join(tmp, '.claude');
      const fakeCodex = path.join(tmp, '.codex');
      const pluginData = path.join(tmp, 'plugin_data');
      const ws = path.join(tmp, 'my-repo');
      const transcript = path.join(tmp, 'transcript_full.jsonl');

      fs.mkdirSync(path.join(ws, '.claude', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(ws, 'subpkg'), { recursive: true });
      fs.mkdirSync(path.join(fakeCodex, 'memories_v2'), { recursive: true });
      fs.mkdirSync(fakeClaude, { recursive: true });

      fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'ROOT_MARKER_111\n');
      fs.writeFileSync(
        path.join(ws, '.claude', 'rules', 'ts-only.md'),
        '---\npaths:\n  - "subpkg/**/*.ts"\n---\nSCOPED_TS_MARKER_222\n',
      );
      fs.writeFileSync(path.join(ws, 'subpkg', 'CLAUDE.md'), 'SUBPKG_MARKER_333\n');
      fs.writeFileSync(path.join(ws, 'subpkg', 'index.ts'), 'export const v = 1;\n');
      fs.writeFileSync(
        path.join(fakeCodex, 'memories_v2', 'memory_summary.md'),
        'v1\n\n## User Profile\nCODEX_SUMMARY_MARKER_444\n',
      );
      fs.writeFileSync(transcript, '{"step_index":0,"type":"USER_INPUT"}\n');

      const env = {
        CLAUDE_CONFIG_DIR: fakeClaude,
        CODEX_HOME: fakeCodex,
        PLUGIN_DATA: pluginData,
      };

      // 1. SessionStart injects plain systemMessage WITHOUT metadata (Phase 0 invariant!)
      const startOut = runHook(
        {
          hookEventName: 'SessionStart',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          cwd: ws,
          transcriptPath: transcript,
        },
        env,
      );
      const startSteps = startOut.injectSteps as Array<{
        systemMessage: { systemMessage: string; metadata?: unknown };
      }>;
      assert.equal(startSteps.length, 1);
      assert.equal(startSteps[0].systemMessage.metadata, undefined, 'MUST NOT include metadata');
      assert.ok(startSteps[0].systemMessage.systemMessage.includes('ROOT_MARKER_111'));
      assert.ok(startSteps[0].systemMessage.systemMessage.includes('CODEX_SUMMARY_MARKER_444'));
      assert.ok(!startSteps[0].systemMessage.systemMessage.includes('SCOPED_TS_MARKER_222'));
      assert.ok(!startSteps[0].systemMessage.systemMessage.includes('SUBPKG_MARKER_333'));

      // 2. Duplicate SessionStart for same conversation is idempotent -> {}
      const dupStart = runHook(
        {
          hookEventName: 'SessionStart',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          cwd: ws,
          transcriptPath: transcript,
        },
        env,
      );
      assert.deepEqual(dupStart, {});

      // 3. PostToolUse on subpkg/index.ts queues scoped rule + subdir CLAUDE.md and outputs {}
      const postOut = runHook(
        {
          hookEventName: 'PostToolUse',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          toolCall: {
            name: 'read_file',
            args: { Path: path.join(ws, 'subpkg', 'index.ts') },
          },
        },
        env,
      );
      assert.deepEqual(postOut, {});

      // 4. Next PreInvocation drains queue and injects plain systemMessage
      const preOut = runHook(
        {
          hookEventName: 'PreInvocation',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          invocationNum: 1,
          initialNumSteps: 5,
          transcriptPath: transcript,
        },
        env,
      );
      const preSteps = preOut.injectSteps as Array<{
        systemMessage: { systemMessage: string; metadata?: unknown };
      }>;
      assert.equal(preSteps.length, 1);
      assert.equal(preSteps[0].systemMessage.metadata, undefined);
      assert.ok(preSteps[0].systemMessage.systemMessage.includes('SCOPED_TS_MARKER_222'));
      assert.ok(preSteps[0].systemMessage.systemMessage.includes('SUBPKG_MARKER_333'));

      // 5. Repeat read_file is deduplicated -> PreInvocation returns {}
      runHook(
        {
          hookEventName: 'PostToolUse',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          toolCall: {
            name: 'read_file',
            args: { Path: path.join(ws, 'subpkg', 'index.ts') },
          },
        },
        env,
      );
      const preDedup = runHook(
        {
          hookEventName: 'PreInvocation',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          invocationNum: 2,
          initialNumSteps: 8,
          transcriptPath: transcript,
        },
        env,
      );
      assert.deepEqual(preDedup, {});

      // 6. Mid-session edits to root CLAUDE.md or Codex summary do NOT trigger
      //    redundant re-injection (aligned with Claude Code & Codex snapshot model)
      fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'ROOT_MARKER_111\nROOT_UPDATED_555\n');
      fs.writeFileSync(
        path.join(fakeCodex, 'memories_v2', 'memory_summary.md'),
        'v1\n\n## User Profile\nCODEX_UPDATED_666\n',
      );
      const futureTime = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(ws, 'CLAUDE.md'), futureTime, futureTime);
      fs.utimesSync(path.join(fakeCodex, 'memories_v2', 'memory_summary.md'), futureTime, futureTime);

      const preMidEdit = runHook(
        {
          hookEventName: 'PreInvocation',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          invocationNum: 3,
          initialNumSteps: 9,
          transcriptPath: transcript,
        },
        env,
      );
      assert.deepEqual(preMidEdit, {}, 'Mid-session edits must stay frozen until compaction');

      // 7. Compaction marker in transcript triggers automatic baseline re-injection
      //    picking up the newly updated disk contents
      fs.appendFileSync(transcript, '{"step_index":9,"type":"CONVERSATION_COMPACT"}\n');
      const preCompact = runHook(
        {
          hookEventName: 'PreInvocation',
          conversationId: 'conv-e2e-1',
          workspacePaths: [ws],
          invocationNum: 0,
          initialNumSteps: 10,
          transcriptPath: transcript,
        },
        env,
      );
      const compactSteps = preCompact.injectSteps as Array<{
        systemMessage: { systemMessage: string };
      }>;
      assert.equal(compactSteps.length, 1);
      assert.ok(compactSteps[0].systemMessage.systemMessage.includes('Re-injected After Compaction'));
      assert.ok(compactSteps[0].systemMessage.systemMessage.includes('ROOT_UPDATED_555'));
      assert.ok(compactSteps[0].systemMessage.systemMessage.includes('CODEX_UPDATED_666'));

      // 7. Multi-root workspacePaths ordering produces byte-identical SessionStart payload
      const wsA = path.join(tmp, 'alpha-repo');
      const wsB = path.join(tmp, 'beta-repo');
      fs.mkdirSync(wsA, { recursive: true });
      fs.mkdirSync(wsB, { recursive: true });
      fs.writeFileSync(path.join(wsA, 'CLAUDE.md'), 'ALPHA_RULE\n');
      fs.writeFileSync(path.join(wsB, 'CLAUDE.md'), 'BETA_RULE\n');

      const outAB = runHook(
        {
          hookEventName: 'SessionStart',
          conversationId: 'conv-order-1',
          workspacePaths: [wsA, wsB],
        },
        env,
      );
      const outBA = runHook(
        {
          hookEventName: 'SessionStart',
          conversationId: 'conv-order-2',
          workspacePaths: [wsB, wsA],
        },
        env,
      );
      assert.deepEqual(outAB, outBA, 'SessionStart payload must be byte-identical regardless of workspacePaths order');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs bundled dist/mcp.cjs over stdio: initialize, tools/list, resources/read, and CRUD tools', async () => {
    const tmp = mkTempDir('um-e2e-mcp-');
    try {
      const fakeClaude = path.join(tmp, '.claude');
      const fakeCodex = path.join(tmp, '.codex');
      const pluginData = path.join(tmp, 'plugin_data');
      const ws = path.join(tmp, 'demo-proj');
      fs.mkdirSync(fakeClaude, { recursive: true });
      fs.mkdirSync(path.join(fakeCodex, 'memories_v2'), { recursive: true });
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(
        path.join(fakeCodex, 'memories_v2', 'memory_summary.md'),
        'v1\n\n## User Profile\nMCP_CODEX_OK\n',
      );

      const child = spawn(process.execPath, [MCP_BUNDLE], {
        env: {
          ...process.env,
          PLUGIN_ROOT: REPO_ROOT,
          PLUGIN_DATA: pluginData,
          CLAUDE_CONFIG_DIR: fakeClaude,
          CODEX_HOME: fakeCodex,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const responses = new Map<number, Record<string, unknown>>();
      const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
      let buf = '';

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (typeof msg.id === 'number') {
            const waiter = waiters.get(msg.id);
            if (waiter) {
              waiters.delete(msg.id);
              waiter(msg);
            } else {
              responses.set(msg.id, msg);
            }
          }
        }
      });

      const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          if (responses.has(id)) {
            const r = responses.get(id)!;
            responses.delete(id);
            resolve(r);
            return;
          }
          const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 5000);
          waiters.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
        });
      };

      try {
        const initRes = await rpc(1, 'initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        });
        assert.ok(initRes.result);
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
        );

        const toolsRes = await rpc(2, 'tools/list');
        const tools = (toolsRes.result as { tools: Array<{ name: string; _meta?: Record<string, unknown> }> }).tools;
        const dashTool = tools.find((t) => t.name === 'open_memory_dashboard');
        assert.ok(dashTool, 'open_memory_dashboard tool must be registered');
        assert.equal(
          (dashTool._meta?.ui as { resourceUri?: string })?.resourceUri,
          'ui://unified-memory/app.html',
        );
        const agyUi = dashTool._meta?.['com.google.antigravity/ui'] as {
          entrypoints?: Array<{ type: string; title: string }>;
        };
        assert.equal(agyUi?.entrypoints?.length, 2);

        const appOnlyTool = tools.find((t) => t.name === 'ui_get_overview');
        assert.deepEqual((appOnlyTool?._meta?.ui as { visibility?: string[] })?.visibility, ['app']);

        const resRead = await rpc(3, 'resources/read', { uri: 'ui://unified-memory/app.html' });
        const contents = (
          resRead.result as { contents: Array<{ mimeType: string; text: string }> }
        ).contents;
        assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
        assert.ok(contents[0].text.includes('<!doctype html>') || contents[0].text.includes('<!DOCTYPE html>'));

        // Save Claude memory via MCP tool
        const saveRes = await rpc(4, 'tools/call', {
          name: 'claude_memory_save',
          arguments: {
            projectPath: ws,
            name: 'test-decision',
            description: 'Keep everything zero-compile',
            type: 'project',
            body: 'We bundle single-file dist outputs for GitHub installs.',
          },
        });
        const saveText = (
          saveRes.result as { content: Array<{ text: string }> }
        ).content[0].text;
        const saveData = JSON.parse(saveText) as { saved: boolean; schema: string };
        assert.equal(saveData.saved, true);
        assert.equal(saveData.schema, 'nested_metadata');

        // Read Codex summary via MCP tool
        const codexRes = await rpc(5, 'tools/call', {
          name: 'codex_memory_summary',
          arguments: {},
        });
        const codexText = (
          codexRes.result as { content: Array<{ text: string }> }
        ).content[0].text;
        assert.ok(codexText.includes('MCP_CODEX_OK'));
      } finally {
        child.kill();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
