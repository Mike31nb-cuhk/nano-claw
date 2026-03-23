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
  buildPlannerPrompt,
  parsePlannerPlan,
  resolvePlannerConfig,
  runPlannerMode,
  validatePlannerPlan,
  PlannerAgentInvocation,
} from './planner-mode.js';

const baseGroup: RegisteredGroup = {
  name: 'Planner Group',
  folder: 'planner-group',
  trigger: '@Andy',
  added_at: '2026-03-23T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('planner-mode helpers', () => {
  it('resolves planner defaults and caps max agents', () => {
    expect(resolvePlannerConfig()).toEqual({
      enabled: false,
      maxAgents: 3,
      plannerModel: undefined,
      workerModel: undefined,
      aggregatorModel: undefined,
    });

    expect(
      resolvePlannerConfig({
        enabled: true,
        maxAgents: 20,
        plannerModel: 'planner-model',
        workerModel: 'worker-model',
        aggregatorModel: 'aggregator-model',
      }),
    ).toEqual({
      enabled: true,
      maxAgents: 5,
      plannerModel: 'planner-model',
      workerModel: 'worker-model',
      aggregatorModel: 'aggregator-model',
    });
  });

  it('builds a planner prompt that requires JSON-only output', () => {
    const prompt = buildPlannerPrompt('Design a launch plan', 4);
    expect(prompt).toContain('Return JSON only.');
    expect(prompt).toContain('"agents"');
    expect(prompt).toContain('Design a launch plan');
  });

  it('parses a fenced planner JSON plan and normalizes worker ids', () => {
    const plan = parsePlannerPlan(
      '```json\n{"agents":[{"role":"critic","goal":"Find risks","instructions":"Focus on failure modes"}]}\n```',
      3,
    );

    expect(plan).toEqual({
      agents: [
        {
          instanceId: 'worker-1',
          role: 'critic',
          goal: 'Find risks',
          instructions: 'Focus on failure modes',
        },
      ],
    });
  });

  it('rejects invalid planner output shapes', () => {
    expect(() => parsePlannerPlan('not json', 3)).toThrow(
      'Planner output must be valid JSON.',
    );
    expect(() => validatePlannerPlan({ agents: [] }, 3)).toThrow(
      'Planner output must include at least one agent.',
    );
    expect(() =>
      validatePlannerPlan(
        {
          agents: [{ role: 'critic', goal: '', instructions: 'Focus here' }],
        },
        3,
      ),
    ).toThrow('field `goal` must be a non-empty string');
    expect(() =>
      validatePlannerPlan(
        {
          agents: [
            { role: 'a', goal: 'a', instructions: 'a' },
            { role: 'b', goal: 'b', instructions: 'b' },
            { role: 'c', goal: 'c', instructions: 'c' },
            { role: 'd', goal: 'd', instructions: 'd' },
          ],
        },
        3,
      ),
    ).toThrow('Planner output exceeds maxAgents');
  });
});

describe('runPlannerMode', () => {
  it('runs planner before workers and aggregator and returns the final output', async () => {
    const calls: PlannerAgentInvocation[] = [];
    const runInstance = vi.fn(async (invocation: PlannerAgentInvocation) => {
      calls.push(invocation);

      if (invocation.role === 'planner') {
        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result:
            '{"agents":[{"role":"critic","goal":"Find gaps","instructions":"Focus on weaknesses"},{"role":"builder","goal":"Produce the implementation path","instructions":"Focus on concrete execution"}]}',
        };
      }

      if (invocation.role === 'aggregator') {
        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result: 'Final planner-mode answer',
        };
      }

      return {
        instanceId: invocation.instanceId,
        role: invocation.role,
        status: 'success' as const,
        result: `Worker output from ${invocation.instanceId}`,
      };
    });

    const result = await runPlannerMode({
      group: {
        ...baseGroup,
        containerConfig: {
          planner: {
            enabled: true,
            maxAgents: 2,
            plannerModel: 'planner-model',
            workerModel: 'worker-model',
            aggregatorModel: 'aggregator-model',
          },
        },
      },
      prompt: 'Design the rollout plan',
      chatJid: 'plan@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('success');
    expect(result.finalResult).toBe('Final planner-mode answer');
    expect(result.plan?.agents).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(calls[0].role).toBe('planner');
    expect(calls[1].role).toBe('worker');
    expect(calls[2].role).toBe('worker');
    expect(calls[3].role).toBe('aggregator');
    expect(calls[0].runtime.model).toBe('planner-model');
    expect(calls[1].runtime.model).toBe('worker-model');
    expect(calls[3].runtime.model).toBe('aggregator-model');
    const writeFileSyncMock = vi.mocked(fs.writeFileSync);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${result.runId}/results/planner.json`),
      expect.any(String),
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${result.runId}/results/plan.json`),
      expect.any(String),
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${result.runId}/results/final.json`),
      expect.any(String),
    );
  });

  it('fails immediately when the planner output is invalid', async () => {
    const runInstance = vi.fn(async (invocation: PlannerAgentInvocation) => ({
      instanceId: invocation.instanceId,
      role: invocation.role,
      status: 'success' as const,
      result: 'not-json',
    }));

    const result = await runPlannerMode({
      group: {
        ...baseGroup,
        containerConfig: {
          planner: {
            enabled: true,
            maxAgents: 2,
          },
        },
      },
      prompt: 'Analyze the request',
      chatJid: 'plan@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('Planner output must be valid JSON.');
    expect(runInstance).toHaveBeenCalledTimes(1);
  });

  it('fails when any planned worker fails', async () => {
    const runInstance = vi.fn(async (invocation: PlannerAgentInvocation) => {
      if (invocation.role === 'planner') {
        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result:
            '{"agents":[{"role":"critic","goal":"Find risks","instructions":"Focus on failure modes"},{"role":"builder","goal":"Draft the build path","instructions":"Focus on implementation"}]}',
        };
      }

      if (invocation.instanceId === 'worker-2') {
        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'error' as const,
          result: null,
          error: 'worker-2 failed',
        };
      }

      return {
        instanceId: invocation.instanceId,
        role: invocation.role,
        status: 'success' as const,
        result: 'Worker output',
      };
    });

    const result = await runPlannerMode({
      group: {
        ...baseGroup,
        containerConfig: {
          planner: {
            enabled: true,
            maxAgents: 2,
          },
        },
      },
      prompt: 'Break down the work',
      chatJid: 'plan@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('worker-2 failed');
    expect(runInstance).toHaveBeenCalledTimes(3);
  });

  it('fails when the aggregator fails after successful workers', async () => {
    const runInstance = vi.fn(async (invocation: PlannerAgentInvocation) => {
      if (invocation.role === 'planner') {
        return {
          instanceId: invocation.instanceId,
          role: invocation.role,
          status: 'success' as const,
          result:
            '{"agents":[{"role":"critic","goal":"Find risks","instructions":"Focus on failure modes"}]}',
        };
      }

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
        result: 'Worker output',
      };
    });

    const result = await runPlannerMode({
      group: {
        ...baseGroup,
        containerConfig: {
          planner: {
            enabled: true,
            maxAgents: 1,
          },
        },
      },
      prompt: 'Summarize the options',
      chatJid: 'plan@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('aggregator failed');
    expect(runInstance).toHaveBeenCalledTimes(3);
  });
});
