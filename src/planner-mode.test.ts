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
  buildPlannerAggregatorPrompt,
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
      fixedAgents: undefined,
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
      fixedAgents: undefined,
      plannerModel: 'planner-model',
      workerModel: 'worker-model',
      aggregatorModel: 'aggregator-model',
    });

    expect(
      resolvePlannerConfig({
        enabled: true,
        maxAgents: 2,
        fixedAgents: 4,
      }),
    ).toEqual({
      enabled: true,
      maxAgents: 4,
      fixedAgents: 4,
      plannerModel: undefined,
      workerModel: undefined,
      aggregatorModel: undefined,
    });
  });

  it('builds a planner prompt that requires JSON-only output', () => {
    const prompt = buildPlannerPrompt('Design a launch plan', 4);
    expect(prompt).toContain('Return JSON only.');
    expect(prompt).toContain('"agents"');
    expect(prompt).toContain('Design a launch plan');
  });

  it('builds a planner prompt that can lock the worker count for experiments', () => {
    const prompt = buildPlannerPrompt('Design a launch plan', 5, 3);
    expect(prompt).toContain('exactly 3 worker agents');
    expect(prompt).toContain('must contain exactly 3 items');
  });

  it('builds an aggregator prompt with the standardized planner output structure', () => {
    const aggregatorPrompt = buildPlannerAggregatorPrompt(
      '设计一个抓钩技能',
      {
        agents: [
          {
            instanceId: 'worker-1',
            role: 'mechanics-designer',
            goal: '负责核心力学与绳索物理',
            instructions: '聚焦物理与状态机',
          },
          {
            instanceId: 'worker-2',
            role: 'ux-designer',
            goal: '负责手感与视觉反馈',
            instructions: '聚焦体验与反馈',
          },
        ],
      },
      [
        {
          instanceId: 'worker-1',
          role: 'worker',
          status: 'success',
          result: 'Worker 1 output',
        },
        {
          instanceId: 'worker-2',
          role: 'worker',
          status: 'success',
          result: 'Worker 2 output',
        },
      ],
    );

    expect(aggregatorPrompt).toContain('## 分工思路');
    expect(aggregatorPrompt).toContain('## 分工角色');
    expect(aggregatorPrompt).toContain('## 实现要点');
    expect(aggregatorPrompt).toContain('## 完整回复');
    expect(aggregatorPrompt).toContain(
      '1. worker-1：mechanics-designer，负责核心力学与绳索物理',
    );
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
    expect(() =>
      validatePlannerPlan(
        {
          agents: [
            { role: 'critic', goal: 'Find risks', instructions: 'Focus' },
          ],
        },
        3,
        2,
      ),
    ).toThrow('Planner output must include exactly 2 agents');
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

  it('fails immediately when fixedAgents is configured but planner returns the wrong count', async () => {
    const runInstance = vi.fn(async (invocation: PlannerAgentInvocation) => ({
      instanceId: invocation.instanceId,
      role: invocation.role,
      status: 'success' as const,
      result:
        '{"agents":[{"role":"critic","goal":"Find risks","instructions":"Focus on failure modes"}]}',
    }));

    const result = await runPlannerMode({
      group: {
        ...baseGroup,
        containerConfig: {
          planner: {
            enabled: true,
            fixedAgents: 2,
          },
        },
      },
      prompt: 'Analyze the request',
      chatJid: 'plan@g.us',
      deps: { runInstance },
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe(
      'Planner output must include exactly 2 agents; received 1.',
    );
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
