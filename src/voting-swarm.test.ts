import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runContainerAgent,
  resolveGroupFolderPath,
  resolveAgentRuntimeScope,
  resolveInstanceIpcPath,
  writeFileSync,
  mkdirSync,
} = vi.hoisted(() => ({
  runContainerAgent: vi.fn(),
  resolveGroupFolderPath: vi.fn((folder: string) => `/groups/${folder}`),
  resolveAgentRuntimeScope: vi.fn(
    (groupFolder: string, runId = 'default-run', instanceId = 'default') => ({
      groupFolder,
      runId,
      instanceId,
    }),
  ),
  resolveInstanceIpcPath: vi.fn(
    (scope: { groupFolder: string; runId: string; instanceId: string }) =>
      `/ipc/${scope.groupFolder}/runs/${scope.runId}/instances/${scope.instanceId}`,
  ),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent,
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath,
  resolveAgentRuntimeScope,
  resolveInstanceIpcPath,
}));

vi.mock('fs', () => ({
  default: {
    writeFileSync,
    mkdirSync,
  },
  writeFileSync,
  mkdirSync,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getInteractionMode,
  getVotingWorkerCount,
  runVotingSwarm,
} from './voting-swarm.js';
import type { RegisteredGroup } from './types.js';

const baseGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

describe('voting swarm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runContainerAgent.mockImplementation(
      async (
        _group: RegisteredGroup,
        input: { instanceId?: string },
        _onProcess: () => void,
        onOutput?: (output: { result: string | null }) => Promise<void>,
      ) => {
        const resultMap: Record<string, string> = {
          'worker-1': 'answer one',
          'worker-2': 'answer two',
          'worker-3': 'answer three',
          aggregator: 'final answer',
        };
        const result = resultMap[input.instanceId || 'worker-1'];
        if (onOutput) {
          await onOutput({ result });
        }
        return {
          status: 'success',
          result: null,
        };
      },
    );
  });

  it('defaults to single mode when vote is not enabled', () => {
    expect(getInteractionMode(baseGroup)).toBe('single');
  });

  it('uses vote mode and default worker count of 3', () => {
    const group: RegisteredGroup = {
      ...baseGroup,
      containerConfig: { interactionMode: 'vote' },
    };
    expect(getInteractionMode(group)).toBe('vote');
    expect(getVotingWorkerCount(group)).toBe(3);
  });

  it('falls back to default worker count for invalid values', () => {
    const group: RegisteredGroup = {
      ...baseGroup,
      containerConfig: { interactionMode: 'vote', workerCount: 99 },
    };
    expect(getVotingWorkerCount(group)).toBe(3);
  });

  it('runs workers and aggregator and saves outputs', async () => {
    const group: RegisteredGroup = {
      ...baseGroup,
      containerConfig: { interactionMode: 'vote' },
    };

    const result = await runVotingSwarm(group, 'Solve this', 'test@g.us');

    expect(result.workerCount).toBe(3);
    expect(result.workerResults).toHaveLength(3);
    expect(result.finalOutput).toBe('final answer');
    expect(runContainerAgent).toHaveBeenCalledTimes(4);

    const instanceIds = runContainerAgent.mock.calls.map(
      (call) => call[1].instanceId,
    );
    expect(instanceIds).toEqual([
      'worker-1',
      'worker-2',
      'worker-3',
      'aggregator',
    ]);

    const writes = writeFileSync.mock.calls.map((call) =>
      String(call[0]).replaceAll('\\', '/'),
    );
    expect(
      writes.some((target) => target.includes('/workers/worker-1.md')),
    ).toBe(true);
    expect(writes.some((target) => target.endsWith('/final.md'))).toBe(true);
    expect(writes.some((target) => target.endsWith('/manifest.json'))).toBe(
      true,
    );
    expect(writes.some((target) => target.endsWith('/input/_close'))).toBe(
      true,
    );
  });
});
