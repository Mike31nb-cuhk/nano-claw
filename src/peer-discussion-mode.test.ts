import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

import type { RegisteredGroup } from './types.js';
import {
  buildPeerDiscussionAggregatorPrompt,
  buildPeerDiscussionWorkerPrompt,
  resolvePeerDiscussionConfig,
  runPeerDiscussionMode,
  PeerDiscussionAgentInvocation,
} from './peer-discussion-mode.js';

const baseGroup: RegisteredGroup = {
  name: 'Peer Discussion Group',
  folder: 'peer-discussion-group',
  trigger: '@Andy',
  added_at: '2026-03-24T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('peer-discussion-mode helpers', () => {
  it('resolves peer-discussion defaults and caps configuration', () => {
    expect(resolvePeerDiscussionConfig()).toEqual({
      enabled: false,
      workerCount: 3,
      maxRounds: 2,
      discussionWindowMs: 60000,
      roundTimeoutMs: 4000,
      workerModel: undefined,
      aggregatorModel: undefined,
    });

    expect(
      resolvePeerDiscussionConfig({
        enabled: true,
        workerCount: 99,
        maxRounds: 99,
        discussionWindowMs: 999999,
        roundTimeoutMs: 999999,
        workerModel: 'worker-model',
        aggregatorModel: 'aggregator-model',
      }),
    ).toEqual({
      enabled: true,
      workerCount: 5,
      maxRounds: 5,
      discussionWindowMs: 120000,
      roundTimeoutMs: 30000,
      workerModel: 'worker-model',
      aggregatorModel: 'aggregator-model',
    });
  });

  it('builds worker and aggregator prompts with peer-discussion context', () => {
    const workerPrompt = buildPeerDiscussionWorkerPrompt(
      'Solve this',
      1,
      3,
      2,
      60000,
    );
    expect(workerPrompt).toContain('peer-discussion mode');
    expect(workerPrompt).toContain('worker 1 of 3');
    expect(workerPrompt).toContain('60 seconds');
    expect(workerPrompt).toContain('mcp__nanoclaw__send_peer_message');

    const aggregatorPrompt = buildPeerDiscussionAggregatorPrompt(
      'Original task',
      [
        {
          instanceId: 'worker-1',
          role: 'discussion-worker',
          status: 'success',
          result: 'Candidate: A\nExplanation A',
        },
        {
          instanceId: 'worker-2',
          role: 'discussion-worker',
          status: 'success',
          result: 'Candidate: B\nExplanation B',
        },
      ],
    );
    expect(aggregatorPrompt).toContain('Original task');
    expect(aggregatorPrompt).toContain('Discussion Convergence');
    expect(aggregatorPrompt).toContain('Final Answer');
    expect(aggregatorPrompt).toContain('Why This Answer');
  });
});

describe('runPeerDiscussionMode', () => {
  it('runs discussion workers before aggregator and returns aggregated output', async () => {
    const calls: PeerDiscussionAgentInvocation[] = [];
    const runInstance = vi.fn(
      async (invocation: PeerDiscussionAgentInvocation) => {
        calls.push(invocation);
        if (invocation.role === 'aggregator') {
          return {
            instanceId: invocation.instanceId,
            role: invocation.role,
            status: 'success' as const,
            result: 'Final peer-discussion answer',
          };
        }

        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result: `Candidate: ${invocation.instanceId}\nDiscussed answer`,
        };
      },
    );

    const result = await runPeerDiscussionMode({
      group: {
        ...baseGroup,
        containerConfig: {
          peerDiscussion: {
            enabled: true,
            workerCount: 3,
            maxRounds: 2,
            discussionWindowMs: 15000,
            roundTimeoutMs: 2500,
            workerModel: 'claude-sonnet-peer-worker',
            aggregatorModel: 'claude-opus-peer-aggregator',
          },
        },
      },
      prompt: 'Debate the best architecture',
      chatJid: 'peer@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('success');
    expect(result.finalResult).toBe('Final peer-discussion answer');
    expect(result.usedFallback).toBe(false);
    expect(result.archiveDir).toBe(
      '/tmp/nanoclaw-test-data/ipc/peer-discussion-group/runs/' +
        result.runId +
        '/results',
    );
    expect(result.peerDiscussionDir).toBe(
      '/tmp/nanoclaw-test-data/ipc/peer-discussion-group/runs/' +
        result.runId +
        '/peer-discussion',
    );
    expect(calls).toHaveLength(4);
    expect(
      calls.slice(0, 3).every((call) => call.role === 'discussion-worker'),
    ).toBe(true);
    expect(calls[3].role).toBe('aggregator');
    expect(calls[0].interactionMode).toBe('peer-discussion');
    expect(calls[0].peerDiscussion?.peers).toEqual(['worker-2', 'worker-3']);
    expect(calls[0].peerDiscussion?.discussionWindowMs).toBe(15000);
    expect(calls[0].runtime.model).toBe('claude-sonnet-peer-worker');
    expect(calls[0].runtime.peerDiscussionDir).toBe(result.peerDiscussionDir);
    expect(calls[3].runtime.model).toBe('claude-opus-peer-aggregator');
    expect(calls[3].prompt).toContain('Discussed answer');

    const writeFileSyncMock = vi.mocked(fs.writeFileSync);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${result.runId}/results/worker-1.json`),
      expect.any(String),
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${result.runId}/results/aggregator.json`),
      expect.any(String),
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${result.runId}/results/final.json`),
      expect.any(String),
    );
  });

  it('falls back to the strongest worker result when the aggregator fails', async () => {
    const runInstance = vi.fn(
      async (invocation: PeerDiscussionAgentInvocation) => {
        if (invocation.role === 'aggregator') {
          return {
            instanceId: invocation.instanceId,
            role: invocation.role,
            status: 'error' as const,
            result: null,
            error: 'aggregator failed',
          };
        }

        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result:
            invocation.instanceId === 'worker-2'
              ? 'Candidate: worker-2\nThis is the longest peer-discussion final answer and should win fallback.'
              : 'Candidate: short\nshort',
        };
      },
    );

    const result = await runPeerDiscussionMode({
      group: {
        ...baseGroup,
        containerConfig: {
          peerDiscussion: {
            enabled: true,
            workerCount: 2,
          },
        },
      },
      prompt: 'Debate a best answer',
      chatJid: 'peer@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('success');
    expect(result.usedFallback).toBe(true);
    expect(result.finalResult).toContain(
      'longest peer-discussion final answer',
    );
    expect(result.error).toBe('aggregator failed');
  });
});
