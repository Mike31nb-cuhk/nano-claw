import { describe, expect, it, beforeEach, vi } from 'vitest';
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
  buildAggregatorPrompt,
  buildVotingWorkerPrompt,
  resolveVotingConfig,
  runVotingMode,
  VotingAgentInvocation,
} from './voting-mode.js';

const baseGroup: RegisteredGroup = {
  name: 'Voting Group',
  folder: 'voting-group',
  trigger: '@Andy',
  added_at: '2026-03-22T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('voting-mode helpers', () => {
  it('resolves worker defaults and caps worker count', () => {
    expect(resolveVotingConfig()).toEqual({
      enabled: false,
      workerCount: 3,
      minSuccesses: 1,
      workerModel: undefined,
      aggregatorModel: undefined,
    });

    expect(
      resolveVotingConfig({
        enabled: true,
        workerCount: 20,
        minSuccesses: 10,
      }),
    ).toEqual({
      enabled: true,
      workerCount: 5,
      minSuccesses: 5,
      workerModel: undefined,
      aggregatorModel: undefined,
    });
  });

  it('builds worker and aggregator prompts with useful context', () => {
    const workerPrompt = buildVotingWorkerPrompt('Solve this', 2, 3);
    expect(workerPrompt).toContain('worker 2 of 3');
    expect(workerPrompt).toContain('Solve this');
    expect(workerPrompt).toContain('Candidate: <your proposed answer>');

    const aggregatorPrompt = buildAggregatorPrompt('Original task', [
      {
        instanceId: 'worker-1',
        role: 'worker',
        status: 'success',
        result: 'Answer A',
      },
      {
        instanceId: 'worker-2',
        role: 'worker',
        status: 'success',
        result: 'Answer B',
      },
    ]);
    expect(aggregatorPrompt).toContain('Original task');
    expect(aggregatorPrompt).toContain('Answer A');
    expect(aggregatorPrompt).toContain('Answer B');
    expect(aggregatorPrompt).toContain('Runner Summary');
    expect(aggregatorPrompt).toContain('Final Answer');
    expect(aggregatorPrompt).toContain('Why');
  });

  it('uses Chinese headings and extracted candidates for Chinese prompts', () => {
    const aggregatorPrompt = buildAggregatorPrompt(
      '猜谜语：什么东西人死后朝天？',
      [
        {
          instanceId: 'worker-1',
          role: 'worker',
          status: 'success',
          result: 'Candidate: 鼻孔\n因为人平躺后鼻孔朝上。',
        },
        {
          instanceId: 'worker-2',
          role: 'worker',
          status: 'success',
          result: 'Candidate: 脚底\n从四脚朝天的角度理解。',
        },
      ],
    );

    expect(aggregatorPrompt).toContain('## Runner 回答');
    expect(aggregatorPrompt).toContain('## 最终答案');
    expect(aggregatorPrompt).toContain('## 为什么');
    expect(aggregatorPrompt).toContain('1. Worker 1: 鼻孔');
    expect(aggregatorPrompt).toContain('2. Worker 2: 脚底');
  });
});

describe('runVotingMode', () => {
  it('runs workers before aggregator and returns aggregated output', async () => {
    const calls: VotingAgentInvocation[] = [];
    const runInstance = vi.fn(async (invocation: VotingAgentInvocation) => {
      calls.push(invocation);
      if (invocation.role === 'aggregator') {
        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result: 'Final aggregated answer',
        };
      }

      return {
        instanceId: invocation.instanceId,
        role: invocation.role,
        status: 'success' as const,
        result: `Worker output from ${invocation.instanceId}`,
      };
    });

    const result = await runVotingMode({
      group: {
        ...baseGroup,
        containerConfig: {
          voting: {
            enabled: true,
            workerCount: 3,
            workerModel: 'claude-sonnet-worker',
            aggregatorModel: 'claude-opus-aggregator',
          },
        },
      },
      prompt: 'Compare three approaches',
      chatJid: 'vote@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('success');
    expect(result.finalResult).toBe('Final aggregated answer');
    expect(result.usedFallback).toBe(false);
    expect(result.archiveDir).toBe(
      '/tmp/nanoclaw-test-data/ipc/voting-group/runs/' +
        result.runId +
        '/results',
    );
    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 3).every((call) => call.role === 'worker')).toBe(
      true,
    );
    expect(calls[3].role).toBe('aggregator');
    expect(calls[0].runtime.model).toBe('claude-sonnet-worker');
    expect(calls[3].runtime.model).toBe('claude-opus-aggregator');
    expect(calls[3].prompt).toContain('Worker output from worker-1');
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
    const runPayload = writeFileSyncMock.mock.calls.find(([filePath]) =>
      String(filePath).includes(`/runs/${result.runId}/results/run.json`),
    )?.[1];
    expect(String(runPayload)).toContain('"workerCandidates"');
  });

  it('falls back to the best worker result when the aggregator fails', async () => {
    const runInstance = vi.fn(async (invocation: VotingAgentInvocation) => {
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
            ? 'This is the longest worker answer and should win the fallback.'
            : 'short',
      };
    });

    const result = await runVotingMode({
      group: {
        ...baseGroup,
        containerConfig: {
          voting: {
            enabled: true,
            workerCount: 2,
          },
        },
      },
      prompt: 'Give me the best answer',
      chatJid: 'vote@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('success');
    expect(result.usedFallback).toBe(true);
    expect(result.finalResult).toContain('longest worker answer');
    expect(result.error).toBe('aggregator failed');
    const finalPayload = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([filePath]) =>
        String(filePath).includes(`/runs/${result.runId}/results/final.json`),
      )?.[1];
    expect(String(finalPayload)).toContain('"usedFallback": true');
    expect(String(finalPayload)).toContain(
      '"finalSourceInstanceId": "worker-2"',
    );
  });
});
