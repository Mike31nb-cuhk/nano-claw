import fs from 'fs';
import path from 'path';

import {
  AgentInstanceRuntime,
  createAgentInstanceRuntime,
} from './container-runner.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { PlannerConfig, RegisteredGroup } from './types.js';

const DEFAULT_PLANNER_MAX_AGENTS = 3;
const MAX_PLANNER_AGENTS = 5;
const HAN_SCRIPT_REGEX = /[\u3400-\u9fff]/;

export interface ResolvedPlannerConfig {
  enabled: boolean;
  maxAgents: number;
  fixedAgents?: number;
  plannerModel?: string;
  workerModel?: string;
  aggregatorModel?: string;
}

export interface NormalizedPlannerAgent {
  instanceId: string;
  role: string;
  goal: string;
  instructions: string;
}

export interface NormalizedPlannerPlan {
  agents: NormalizedPlannerAgent[];
}

export interface PlannerAgentInvocation {
  instanceId: string;
  role: 'planner' | 'worker' | 'aggregator';
  prompt: string;
  runtime: AgentInstanceRuntime;
  planAgent?: NormalizedPlannerAgent;
}

export interface PlannerAgentResult {
  instanceId: string;
  role: 'planner' | 'worker' | 'aggregator';
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

export interface PlannerModeDeps {
  runInstance: (
    invocation: PlannerAgentInvocation,
  ) => Promise<PlannerAgentResult>;
}

export interface PlannerModeResult {
  status: 'success' | 'error';
  runId: string;
  archiveDir: string;
  finalResult: string | null;
  plan?: NormalizedPlannerPlan;
  plannerResult?: PlannerAgentResult;
  workerResults: PlannerAgentResult[];
  aggregatorResult?: PlannerAgentResult;
  error?: string;
}

function isLikelyChinese(text: string): boolean {
  return HAN_SCRIPT_REGEX.test(text);
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() || trimmed;
}

function normalizeNonEmptyString(
  value: unknown,
  fieldName: string,
  agentIndex: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `Planner agent ${agentIndex + 1} field \`${fieldName}\` must be a non-empty string.`,
    );
  }

  return value.trim();
}

export function resolvePlannerConfig(
  config?: PlannerConfig,
): ResolvedPlannerConfig {
  const enabled = config?.enabled === true;
  const fixedAgents =
    typeof config?.fixedAgents === 'number'
      ? Math.max(1, Math.min(config.fixedAgents, MAX_PLANNER_AGENTS))
      : undefined;
  const maxAgents =
    fixedAgents ||
    Math.max(
      1,
      Math.min(
        config?.maxAgents || DEFAULT_PLANNER_MAX_AGENTS,
        MAX_PLANNER_AGENTS,
      ),
    );

  return {
    enabled,
    maxAgents,
    fixedAgents,
    plannerModel: config?.plannerModel,
    workerModel: config?.workerModel,
    aggregatorModel: config?.aggregatorModel,
  };
}

export function createPlannerRunId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildPlannerPrompt(
  userPrompt: string,
  maxAgents: number,
  fixedAgents?: number,
): string {
  const agentCountInstruction = fixedAgents
    ? `Create a focused execution plan with exactly ${fixedAgents} worker agents.`
    : `Create a focused execution plan with between 1 and ${maxAgents} worker agents.`;
  const agentCountSchemaRule = fixedAgents
    ? `The \`agents\` array must contain exactly ${fixedAgents} items.`
    : `The \`agents\` array may contain between 1 and ${maxAgents} items.`;
  return [
    'You are the planner in a planner-style multi-agent run inside NanoClaw.',
    agentCountInstruction,
    'Return JSON only. Do not include commentary before or after the JSON.',
    'Use exactly this schema:',
    '{',
    '  "agents": [',
    '    {',
    '      "role": "critic",',
    '      "goal": "Find the weakest part of the proposal",',
    '      "instructions": "Focus on state machine risks and fallback handling"',
    '    }',
    '  ]',
    '}',
    agentCountSchemaRule,
    'Each agent must contain only these non-empty string fields: role, goal, instructions.',
    'Do not include ids, models, tool settings, or any extra keys.',
    '',
    'User request:',
    userPrompt,
  ].join('\n');
}

export function validatePlannerPlan(
  plan: unknown,
  maxAgents: number,
  fixedAgents?: number,
): NormalizedPlannerPlan {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Planner output must be a JSON object.');
  }

  const agents = (plan as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) {
    throw new Error('Planner output must include an `agents` array.');
  }

  if (agents.length === 0) {
    throw new Error('Planner output must include at least one agent.');
  }

  if (fixedAgents && agents.length !== fixedAgents) {
    throw new Error(
      `Planner output must include exactly ${fixedAgents} agents; received ${agents.length}.`,
    );
  }

  if (agents.length > maxAgents) {
    throw new Error(
      `Planner output exceeds maxAgents: received ${agents.length}, max is ${maxAgents}.`,
    );
  }

  return {
    agents: agents.map((agent, index) => {
      if (!agent || typeof agent !== 'object') {
        throw new Error(`Planner agent ${index + 1} must be an object.`);
      }

      const candidate = agent as Record<string, unknown>;
      return {
        instanceId: `worker-${index + 1}`,
        role: normalizeNonEmptyString(candidate.role, 'role', index),
        goal: normalizeNonEmptyString(candidate.goal, 'goal', index),
        instructions: normalizeNonEmptyString(
          candidate.instructions,
          'instructions',
          index,
        ),
      };
    }),
  };
}

export function parsePlannerPlan(
  raw: string,
  maxAgents: number,
  fixedAgents?: number,
): NormalizedPlannerPlan {
  const stripped = stripCodeFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Planner output must be valid JSON.');
  }

  return validatePlannerPlan(parsed, maxAgents, fixedAgents);
}

export function buildPlannerWorkerPrompt(
  userPrompt: string,
  agent: NormalizedPlannerAgent,
  workerIndex: number,
  workerCount: number,
): string {
  return [
    'You are participating in a planner-style multi-agent run inside NanoClaw.',
    `You are worker ${workerIndex} of ${workerCount}.`,
    `Assigned role: ${agent.role}`,
    `Assigned goal: ${agent.goal}`,
    `Specific instructions: ${agent.instructions}`,
    'Focus on your assigned angle while still answering the user request directly.',
    'Do not assume you know what the other workers will say.',
    'Do not send messages, create tasks, or alter host state unless the user explicitly requires it.',
    'Return a complete final answer, not notes about the process.',
    'Start with one short line in the format: `Candidate: <your proposed answer>`.',
    'After that, give a brief explanation that supports your candidate answer.',
    'Use the same language as the user request unless there is a strong reason not to.',
    '',
    'User request:',
    userPrompt,
  ].join('\n');
}

export function buildPlannerAggregatorPrompt(
  userPrompt: string,
  plan: NormalizedPlannerPlan,
  workerResults: PlannerAgentResult[],
): string {
  const useChinese = isLikelyChinese(userPrompt);
  const planLines = plan.agents.map(
    (agent, index) =>
      `${index + 1}. ${agent.instanceId} | role=${agent.role} | goal=${agent.goal} | instructions=${agent.instructions}`,
  );
  const roleSummaryLines = plan.agents.map(
    (agent, index) =>
      `${index + 1}. ${agent.instanceId}：${agent.role}，${agent.goal}`,
  );
  const roleSummaryLinesEn = plan.agents.map(
    (agent, index) =>
      `${index + 1}. ${agent.instanceId}: ${agent.role}, ${agent.goal}`,
  );
  const workerSections = workerResults.map((result, index) => {
    const agent = plan.agents[index];
    return [
      `${agent.instanceId} (${agent.role})`,
      result.result || '[no result]',
    ].join('\n');
  });

  if (useChinese) {
    return [
      '你是 NanoClaw 分工模式中的 aggregator。',
      '你会收到原始用户请求、一份已验证的分工计划，以及每个 worker 的输出。',
      '请综合这些材料，输出一份结构清晰、面向用户的最终答案。',
      '可以简短说明分工，但不要长篇复述内部编排过程。',
      '如果 worker 之间有冲突，请主动做判断并输出单一答案。',
      '使用与用户请求相同的语言。',
      '你的回答必须严格按下面顺序输出：',
      '## 分工思路',
      '用 2 到 4 句说明为什么这样拆分任务，以及整体是如何收敛的。',
      '',
      '## 分工角色',
      '按顺序列出每个 worker 的角色与职责，每个 worker 一行。',
      `示例：1. worker-1：mechanics-designer，负责核心力学与绳索物理`,
      '',
      '## 实现要点',
      '用 3 到 5 条短 bullet 概括最终方案的关键实现思路。',
      '',
      '## 完整回复',
      '最后给出完整、可直接阅读的正式回答。',
      '',
      '原始用户请求：',
      userPrompt,
      '',
      '分工计划：',
      planLines.join('\n'),
      '',
      '建议使用的角色摘要：',
      roleSummaryLines.join('\n'),
      '',
      'Worker 输出：',
      workerSections.join('\n\n'),
    ].join('\n');
  }

  return [
    'You are the aggregator in a planner-style multi-agent run inside NanoClaw.',
    'You will receive the original user request, a validated work plan, and the outputs from each worker.',
    'Synthesize them into one structured final answer for the user.',
    'You may briefly explain the work split, but do not spend too much time describing internal orchestration.',
    'If the workers disagree, resolve the conflict and present one clear answer.',
    'Use the same language as the user request unless there is a strong reason not to.',
    'Your answer must use this exact section order:',
    '## Work Split',
    'Use 2 to 4 sentences to explain the division strategy and how the plan converged.',
    '',
    '## Worker Roles',
    'List each worker in order, one line each, with role and responsibility.',
    `Example: 1. worker-1: mechanics-designer, responsible for core mechanics and rope physics`,
    '',
    '## Implementation Summary',
    'Give 3 to 5 short bullet points that summarize the key implementation ideas.',
    '',
    '## Full Response',
    'Finish with the complete user-facing answer.',
    '',
    'Original user request:',
    userPrompt,
    '',
    'Validated plan:',
    planLines.join('\n'),
    '',
    'Suggested worker role summary:',
    roleSummaryLinesEn.join('\n'),
    '',
    'Worker outputs:',
    workerSections.join('\n\n'),
  ].join('\n');
}

function getPlannerArchiveDir(groupFolder: string, runId: string): string {
  return path.join(resolveGroupIpcPath(groupFolder), 'runs', runId, 'results');
}

function writePlannerArchiveJson(
  archiveDir: string,
  filename: string,
  payload: unknown,
): void {
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, filename),
    JSON.stringify(payload, null, 2) + '\n',
  );
}

function archivePlannerRun(args: {
  group: RegisteredGroup;
  chatJid: string;
  prompt: string;
  runId: string;
  config: ResolvedPlannerConfig;
  plannerInvocation: PlannerAgentInvocation;
  plannerResult?: PlannerAgentResult;
  plannerParseError?: string;
  plan?: NormalizedPlannerPlan;
  workerInvocations?: PlannerAgentInvocation[];
  workerResults: PlannerAgentResult[];
  aggregatorInvocation?: PlannerAgentInvocation;
  aggregatorResult?: PlannerAgentResult;
  finalResult: string | null;
  error?: string;
  status: 'success' | 'error';
}): string {
  const archiveDir = getPlannerArchiveDir(args.group.folder, args.runId);
  const archivedAt = new Date().toISOString();

  writePlannerArchiveJson(archiveDir, 'request.json', {
    runId: args.runId,
    mode: 'planner',
    groupFolder: args.group.folder,
    groupName: args.group.name,
    chatJid: args.chatJid,
    prompt: args.prompt,
    config: args.config,
    archivedAt,
  });

  writePlannerArchiveJson(archiveDir, 'planner.json', {
    runId: args.runId,
    instanceId: args.plannerInvocation.instanceId,
    role: args.plannerInvocation.role,
    model: args.plannerInvocation.runtime.model,
    prompt: args.plannerInvocation.prompt,
    runtime: args.plannerInvocation.runtime,
    result: args.plannerResult?.result || null,
    status: args.plannerResult?.status || 'error',
    error: args.plannerResult?.error,
    parseStatus: args.plan ? 'success' : 'error',
    parseError: args.plannerParseError,
    archivedAt,
  });

  writePlannerArchiveJson(archiveDir, 'plan.json', {
    runId: args.runId,
    agentCount: args.plan?.agents.length || 0,
    agents: args.plan?.agents || null,
    archivedAt,
  });

  writePlannerArchiveJson(archiveDir, 'run.json', {
    runId: args.runId,
    groupFolder: args.group.folder,
    groupName: args.group.name,
    status: args.status,
    error: args.error,
    plannerStatus: args.plannerResult?.status || 'error',
    plannedAgentCount: args.plan?.agents.length || 0,
    successfulWorkers: args.workerResults.filter(
      (result) => result.status === 'success' && result.result,
    ).length,
    archivedAt,
  });

  for (const invocation of args.workerInvocations || []) {
    const workerResult = args.workerResults.find(
      (result) => result.instanceId === invocation.instanceId,
    );
    writePlannerArchiveJson(archiveDir, `${invocation.instanceId}.json`, {
      runId: args.runId,
      instanceId: invocation.instanceId,
      role: invocation.role,
      model: invocation.runtime.model,
      prompt: invocation.prompt,
      runtime: invocation.runtime,
      planAgent: invocation.planAgent || null,
      result: workerResult?.result || null,
      status: workerResult?.status || 'error',
      error: workerResult?.error,
      archivedAt,
    });
  }

  if (args.aggregatorInvocation || args.aggregatorResult) {
    writePlannerArchiveJson(archiveDir, 'aggregator.json', {
      runId: args.runId,
      instanceId: args.aggregatorInvocation?.instanceId || 'aggregator',
      role: 'aggregator',
      model: args.aggregatorInvocation?.runtime.model,
      prompt: args.aggregatorInvocation?.prompt,
      runtime: args.aggregatorInvocation?.runtime,
      result: args.aggregatorResult?.result || null,
      status: args.aggregatorResult?.status || 'error',
      error: args.aggregatorResult?.error,
      archivedAt,
    });
  }

  writePlannerArchiveJson(archiveDir, 'final.json', {
    runId: args.runId,
    status: args.status,
    finalResult: args.finalResult,
    error: args.error,
    archivedAt,
  });

  return archiveDir;
}

export async function runPlannerMode(args: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  deps: PlannerModeDeps;
}): Promise<PlannerModeResult> {
  const { group, prompt, chatJid, deps } = args;
  const config = resolvePlannerConfig(group.containerConfig?.planner);
  const runId = createPlannerRunId();
  const archiveDir = getPlannerArchiveDir(group.folder, runId);

  logger.info(
    {
      group: group.name,
      runId,
      maxAgents: config.maxAgents,
      fixedAgents: config.fixedAgents,
    },
    'Starting planner-mode run',
  );

  const plannerInvocation: PlannerAgentInvocation = {
    instanceId: 'planner',
    role: 'planner',
    prompt: buildPlannerPrompt(prompt, config.maxAgents, config.fixedAgents),
    runtime: createAgentInstanceRuntime(
      group.folder,
      runId,
      'planner',
      config.plannerModel,
    ),
  };

  const plannerResult = await deps.runInstance(plannerInvocation);
  if (plannerResult.status !== 'success' || !plannerResult.result) {
    const error = plannerResult.error || 'Planner produced no usable output.';
    archivePlannerRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      plannerInvocation,
      plannerResult,
      workerResults: [],
      finalResult: null,
      error,
      status: 'error',
    });
    return {
      status: 'error',
      runId,
      archiveDir,
      finalResult: null,
      plannerResult,
      workerResults: [],
      error,
    };
  }

  let plan: NormalizedPlannerPlan;
  try {
    plan = parsePlannerPlan(
      plannerResult.result,
      config.maxAgents,
      config.fixedAgents,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    archivePlannerRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      plannerInvocation,
      plannerResult,
      plannerParseError: error,
      workerResults: [],
      finalResult: null,
      error,
      status: 'error',
    });
    return {
      status: 'error',
      runId,
      archiveDir,
      finalResult: null,
      plannerResult,
      workerResults: [],
      error,
    };
  }

  const workerInvocations: PlannerAgentInvocation[] = plan.agents.map(
    (agent, index) => ({
      instanceId: agent.instanceId,
      role: 'worker',
      prompt: buildPlannerWorkerPrompt(
        prompt,
        agent,
        index + 1,
        plan.agents.length,
      ),
      runtime: createAgentInstanceRuntime(
        group.folder,
        runId,
        agent.instanceId,
        config.workerModel,
      ),
      planAgent: agent,
    }),
  );

  const settledWorkers = await Promise.allSettled(
    workerInvocations.map((invocation) => deps.runInstance(invocation)),
  );

  const workerResults = settledWorkers.map((settled, index) => {
    const invocation = workerInvocations[index];
    if (settled.status === 'fulfilled') {
      return settled.value;
    }
    return {
      instanceId: invocation.instanceId,
      role: invocation.role,
      status: 'error',
      result: null,
      error:
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason),
    } satisfies PlannerAgentResult;
  });

  const failedWorker = workerResults.find(
    (result) => result.status !== 'success' || !result.result,
  );
  if (failedWorker) {
    const error = failedWorker.error || `${failedWorker.instanceId} failed.`;
    archivePlannerRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      plannerInvocation,
      plannerResult,
      plan,
      workerInvocations,
      workerResults,
      finalResult: null,
      error,
      status: 'error',
    });
    return {
      status: 'error',
      runId,
      archiveDir,
      finalResult: null,
      plan,
      plannerResult,
      workerResults,
      error,
    };
  }

  const aggregatorInvocation: PlannerAgentInvocation = {
    instanceId: 'aggregator',
    role: 'aggregator',
    prompt: buildPlannerAggregatorPrompt(prompt, plan, workerResults),
    runtime: createAgentInstanceRuntime(
      group.folder,
      runId,
      'aggregator',
      config.aggregatorModel,
    ),
  };

  const aggregatorResult = await deps.runInstance(aggregatorInvocation);
  if (aggregatorResult.status === 'success' && aggregatorResult.result) {
    archivePlannerRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      plannerInvocation,
      plannerResult,
      plan,
      workerInvocations,
      workerResults,
      aggregatorInvocation,
      aggregatorResult,
      finalResult: aggregatorResult.result,
      status: 'success',
    });
    return {
      status: 'success',
      runId,
      archiveDir,
      finalResult: aggregatorResult.result,
      plan,
      plannerResult,
      workerResults,
      aggregatorResult,
    };
  }

  const error = aggregatorResult.error || 'Planner-mode aggregation failed.';
  archivePlannerRun({
    group,
    chatJid,
    prompt,
    runId,
    config,
    plannerInvocation,
    plannerResult,
    plan,
    workerInvocations,
    workerResults,
    aggregatorInvocation,
    aggregatorResult,
    finalResult: null,
    error,
    status: 'error',
  });
  return {
    status: 'error',
    runId,
    archiveDir,
    finalResult: null,
    plan,
    plannerResult,
    workerResults,
    aggregatorResult,
    error,
  };
}
