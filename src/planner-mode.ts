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
const DEFAULT_PLANNER_MAX_ROUNDS = 1;
const MAX_PLANNER_ROUNDS = 5;
const HAN_SCRIPT_REGEX = /[\u3400-\u9fff]/;

export interface ResolvedPlannerConfig {
  enabled: boolean;
  maxAgents: number;
  fixedAgents?: number;
  maxRounds: number;
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

interface IterativePlannerDecision {
  action: 'continue' | 'finalize';
  reason?: string;
  plan?: NormalizedPlannerPlan;
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
  rounds: PlannerExecutionRound[];
  error?: string;
}

export interface PlannerExecutionRound {
  round: number;
  plannerInvocation: PlannerAgentInvocation;
  plannerResult?: PlannerAgentResult;
  plannerParseError?: string;
  plannerDecision: 'continue' | 'finalize' | 'error';
  plannerDecisionReason?: string;
  plan?: NormalizedPlannerPlan;
  workerInvocations: PlannerAgentInvocation[];
  workerResults: PlannerAgentResult[];
  aggregatorInvocation?: PlannerAgentInvocation;
  aggregatorResult?: PlannerAgentResult;
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
  const maxRounds = Math.max(
    1,
    Math.min(
      config?.maxRounds || DEFAULT_PLANNER_MAX_ROUNDS,
      MAX_PLANNER_ROUNDS,
    ),
  );

  return {
    enabled,
    maxAgents,
    fixedAgents,
    maxRounds,
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

function buildIterativePlannerPrompt(args: {
  userPrompt: string;
  maxAgents: number;
  fixedAgents?: number;
  round: number;
  maxRounds: number;
  previousRounds: PlannerExecutionRound[];
}): string {
  const {
    userPrompt,
    maxAgents,
    fixedAgents,
    round,
    maxRounds,
    previousRounds,
  } = args;
  const continueConstraint = fixedAgents
    ? `If you choose \`"action":"continue"\`, the \`agents\` array must contain exactly ${fixedAgents} items.`
    : `If you choose \`"action":"continue"\`, the \`agents\` array may contain between 1 and ${maxAgents} items.`;
  const roundHistory =
    previousRounds.length === 0
      ? 'No previous rounds exist yet.'
      : previousRounds
          .map((previousRound) => {
            const planLines =
              previousRound.plan?.agents.map(
                (agent, index) =>
                  `${index + 1}. ${agent.instanceId} | role=${agent.role} | goal=${agent.goal} | instructions=${agent.instructions}`,
              ) || [];
            const workerLines = previousRound.workerResults.map(
              (result, index) =>
                `${index + 1}. ${result.instanceId}: ${result.result || '[no result]'}`,
            );
            return [
              `Round ${previousRound.round}`,
              `Planner decision: ${previousRound.plannerDecision}`,
              previousRound.plannerDecisionReason
                ? `Planner reason: ${previousRound.plannerDecisionReason}`
                : null,
              planLines.length > 0 ? 'Plan:' : null,
              planLines.length > 0 ? planLines.join('\n') : null,
              workerLines.length > 0 ? 'Worker outputs:' : null,
              workerLines.length > 0 ? workerLines.join('\n') : null,
              previousRound.aggregatorResult?.result
                ? `Aggregator output:\n${previousRound.aggregatorResult.result}`
                : null,
            ]
              .filter(Boolean)
              .join('\n');
          })
          .join('\n\n');

  return [
    'You are the planner in an iterative planner-style multi-agent run inside NanoClaw.',
    `This is planning round ${round} of at most ${maxRounds}.`,
    'You will inspect the current state of the run and decide whether to stop or schedule another worker round.',
    'Return JSON only. Do not include commentary before or after the JSON.',
    'Use exactly one of these schemas:',
    '{',
    '  "action": "continue",',
    '  "reason": "Why another worker round is worthwhile",',
    '  "agents": [',
    '    {',
    '      "role": "critic",',
    '      "goal": "Find the weakest part of the proposal",',
    '      "instructions": "Focus on failure modes and missing detail"',
    '    }',
    '  ]',
    '}',
    'or',
    '{',
    '  "action": "finalize",',
    '  "reason": "Why the current aggregated answer is already sufficient"',
    '}',
    continueConstraint,
    'If you choose `finalize`, do not include `agents`.',
    'If you choose `continue`, every agent must contain only these non-empty string fields: role, goal, instructions.',
    round === 1
      ? 'Because there is no aggregated answer yet, round 1 must use `"action":"continue"`.'
      : 'Choose `"action":"finalize"` only if the latest aggregated answer is already ready to return to the user.',
    '',
    'User request:',
    userPrompt,
    '',
    'Run history so far:',
    roundHistory,
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

function parseIterativePlannerDecision(args: {
  raw: string;
  maxAgents: number;
  fixedAgents?: number;
  round: number;
}): IterativePlannerDecision {
  const stripped = stripCodeFences(args.raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Planner output must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Planner output must be a JSON object.');
  }

  const candidate = parsed as Record<string, unknown>;
  const action = candidate.action;
  const reason =
    typeof candidate.reason === 'string' && candidate.reason.trim()
      ? candidate.reason.trim()
      : undefined;

  if (action !== 'continue' && action !== 'finalize') {
    throw new Error(
      'Planner output must include `action` set to either `continue` or `finalize`.',
    );
  }

  if (action === 'finalize') {
    if (args.round === 1) {
      throw new Error(
        'Planner cannot finalize on round 1 because no aggregated answer exists yet.',
      );
    }
    return { action, reason };
  }

  return {
    action,
    reason,
    plan: validatePlannerPlan(parsed, args.maxAgents, args.fixedAgents),
  };
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
  round?: number,
  maxRounds?: number,
  previousRounds: PlannerExecutionRound[] = [],
): string {
  const useChinese = isLikelyChinese(userPrompt);
  const iterativeMode = Boolean(round && maxRounds && maxRounds > 1);
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
  const previousRoundSummaryZh =
    previousRounds.length === 0
      ? '此前没有已完成轮次。'
      : previousRounds
          .map((previousRound) => {
            const previousPlanLines =
              previousRound.plan?.agents.map(
                (agent, index) =>
                  `${index + 1}. ${agent.instanceId}：${agent.role}，${agent.goal}`,
              ) || [];
            return [
              `第 ${previousRound.round} 轮`,
              '分工：',
              previousPlanLines.join('\n') || '无',
              '该轮聚合输出：',
              previousRound.aggregatorResult?.result || '[无结果]',
            ].join('\n');
          })
          .join('\n\n');
  const previousRoundSummaryEn =
    previousRounds.length === 0
      ? 'No previous rounds have completed yet.'
      : previousRounds
          .map((previousRound) => {
            const previousPlanLines =
              previousRound.plan?.agents.map(
                (agent, index) =>
                  `${index + 1}. ${agent.instanceId}: ${agent.role}, ${agent.goal}`,
              ) || [];
            return [
              `Round ${previousRound.round}`,
              'Work split:',
              previousPlanLines.join('\n') || 'None',
              'Aggregated output:',
              previousRound.aggregatorResult?.result || '[no result]',
            ].join('\n');
          })
          .join('\n\n');

  if (iterativeMode && useChinese) {
    return [
      '你是 NanoClaw 迭代式 planner mode 中的 aggregator。',
      '你会收到原始用户请求、之前已完成轮次的摘要、当前轮的分工计划，以及当前轮 worker 的输出。',
      `当前是第 ${round} 轮聚合，最多允许 ${maxRounds} 轮。请先讲清每轮如何分工、流程如何推进，再给出真正的正式回答。`,
      '如果当前轮已经足够完整，也要把它作为一个完整阶段写清楚。',
      '不要长篇描述内部编排术语，但要让用户能看懂每一轮分别做了什么。',
      '你的回答必须严格按下面顺序输出：',
      '## 每轮分工',
      '按轮次列出每一轮的角色分配与职责，先写已完成轮次，再写当前轮。',
      '',
      '## 推进流程',
      '用 2 到 5 条短 bullet 说明各轮之间是如何推进、修正和收敛的。',
      '',
      '## 最终回答',
      '最后给出可以直接发送给用户的正式回答。',
      '',
      '原始用户请求：',
      userPrompt,
      '',
      '已完成轮次摘要：',
      previousRoundSummaryZh,
      '',
      `当前轮（第 ${round} 轮）分工计划：`,
      roleSummaryLines.join('\n'),
      '',
      '当前轮 Worker 输出：',
      workerSections.join('\n\n'),
    ].join('\n');
  }

  if (useChinese) {
    return [
      '你是 NanoClaw 分工模式中的 aggregator。',
      '你会收到原始用户请求、一份已验证的分工计划，以及每个 worker 的输出。',
      '请综合这些材料，输出一份结构清晰、面向用户的最终答案。',
      round && maxRounds
        ? `当前是第 ${round} 轮聚合，最多允许 ${maxRounds} 轮。请给出这一轮能得到的最强答案，后续 planner 可能决定是否继续。`
        : null,
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
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (iterativeMode) {
    return [
      'You are the aggregator in NanoClaw iterative planner mode.',
      'You will receive the original user request, summaries of completed rounds, the current round work plan, and the current worker outputs.',
      `This is aggregation round ${round} of at most ${maxRounds}. First explain the work split for each round and how the process evolved, then give the real user-facing answer.`,
      'Even if the current round already looks sufficient, present it as one explicit step in the overall progression.',
      'Do not over-explain internal orchestration jargon, but make the round-by-round evolution easy for the user to follow.',
      'Your answer must use this exact section order:',
      '## Round-by-Round Split',
      'List each round in order, explaining the worker roles and responsibilities for that round.',
      '',
      '## Process Flow',
      'Use 2 to 5 short bullet points to explain how the rounds refined, corrected, or expanded the answer.',
      '',
      '## Final Response',
      'Finish with the complete user-facing answer.',
      '',
      'Original user request:',
      userPrompt,
      '',
      'Completed round summaries:',
      previousRoundSummaryEn,
      '',
      `Current round plan (round ${round}):`,
      roleSummaryLinesEn.join('\n'),
      '',
      'Current worker outputs:',
      workerSections.join('\n\n'),
    ].join('\n');
  }

  return [
    'You are the aggregator in a planner-style multi-agent run inside NanoClaw.',
    'You will receive the original user request, a validated work plan, and the outputs from each worker.',
    'Synthesize them into one structured final answer for the user.',
    round && maxRounds
      ? `This is aggregation round ${round} of at most ${maxRounds}. Produce the strongest answer available from this round; the planner may still decide whether another round is needed.`
      : null,
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
  ]
    .filter(Boolean)
    .join('\n');
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
  rounds: PlannerExecutionRound[];
  finalResult: string | null;
  finalSourceRound?: number;
  error?: string;
  status: 'success' | 'error';
}): string {
  const archiveDir = getPlannerArchiveDir(args.group.folder, args.runId);
  const archivedAt = new Date().toISOString();
  const lastExecutedRound =
    [...args.rounds]
      .reverse()
      .find(
        (round) =>
          round.plan ||
          round.workerInvocations.length > 0 ||
          round.aggregatorInvocation,
      ) || args.rounds[args.rounds.length - 1];
  const successfulWorkers = args.rounds
    .flatMap((round) => round.workerResults)
    .filter((result) => result.status === 'success' && result.result).length;

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
    round: lastExecutedRound?.round || null,
    instanceId: lastExecutedRound?.plannerInvocation.instanceId || null,
    role: lastExecutedRound?.plannerInvocation.role || 'planner',
    model: lastExecutedRound?.plannerInvocation.runtime.model,
    prompt: lastExecutedRound?.plannerInvocation.prompt,
    runtime: lastExecutedRound?.plannerInvocation.runtime,
    result: lastExecutedRound?.plannerResult?.result || null,
    status: lastExecutedRound?.plannerResult?.status || 'error',
    error: lastExecutedRound?.plannerResult?.error,
    decision: lastExecutedRound?.plannerDecision || 'error',
    decisionReason: lastExecutedRound?.plannerDecisionReason,
    parseStatus: lastExecutedRound?.plan ? 'success' : 'error',
    parseError: lastExecutedRound?.plannerParseError,
    archivedAt,
  });

  writePlannerArchiveJson(archiveDir, 'plan.json', {
    runId: args.runId,
    round: lastExecutedRound?.round || null,
    agentCount: lastExecutedRound?.plan?.agents.length || 0,
    agents: lastExecutedRound?.plan?.agents || null,
    archivedAt,
  });

  writePlannerArchiveJson(archiveDir, 'run.json', {
    runId: args.runId,
    groupFolder: args.group.folder,
    groupName: args.group.name,
    status: args.status,
    error: args.error,
    maxRounds: args.config.maxRounds,
    roundCount: args.rounds.length,
    executedWorkerRounds: args.rounds.filter((round) => round.plan).length,
    finalSourceRound: args.finalSourceRound || null,
    plannerStatus: lastExecutedRound?.plannerResult?.status || 'error',
    plannedAgentCount: lastExecutedRound?.plan?.agents.length || 0,
    successfulWorkers,
    archivedAt,
  });

  for (const invocation of lastExecutedRound?.workerInvocations || []) {
    const workerResult = lastExecutedRound?.workerResults.find(
      (result) => result.instanceId === invocation.instanceId,
    );
    writePlannerArchiveJson(archiveDir, `${invocation.instanceId}.json`, {
      runId: args.runId,
      round: lastExecutedRound?.round || null,
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

  if (
    lastExecutedRound?.aggregatorInvocation ||
    lastExecutedRound?.aggregatorResult
  ) {
    writePlannerArchiveJson(archiveDir, 'aggregator.json', {
      runId: args.runId,
      round: lastExecutedRound?.round || null,
      instanceId:
        lastExecutedRound?.aggregatorInvocation?.instanceId || 'aggregator',
      role: 'aggregator',
      model: lastExecutedRound?.aggregatorInvocation?.runtime.model,
      prompt: lastExecutedRound?.aggregatorInvocation?.prompt,
      runtime: lastExecutedRound?.aggregatorInvocation?.runtime,
      result: lastExecutedRound?.aggregatorResult?.result || null,
      status: lastExecutedRound?.aggregatorResult?.status || 'error',
      error: lastExecutedRound?.aggregatorResult?.error,
      archivedAt,
    });
  }

  writePlannerArchiveJson(
    archiveDir,
    'rounds.json',
    args.rounds.map((round) => ({
      round: round.round,
      planner: {
        instanceId: round.plannerInvocation.instanceId,
        model: round.plannerInvocation.runtime.model,
        prompt: round.plannerInvocation.prompt,
        result: round.plannerResult?.result || null,
        status: round.plannerResult?.status || 'error',
        error: round.plannerResult?.error,
        decision: round.plannerDecision,
        decisionReason: round.plannerDecisionReason,
        parseError: round.plannerParseError,
      },
      plan: round.plan || null,
      workers: round.workerInvocations.map((invocation) => {
        const workerResult = round.workerResults.find(
          (result) => result.instanceId === invocation.instanceId,
        );
        return {
          instanceId: invocation.instanceId,
          model: invocation.runtime.model,
          prompt: invocation.prompt,
          planAgent: invocation.planAgent || null,
          result: workerResult?.result || null,
          status: workerResult?.status || 'error',
          error: workerResult?.error,
        };
      }),
      aggregator: round.aggregatorInvocation
        ? {
            instanceId: round.aggregatorInvocation.instanceId,
            model: round.aggregatorInvocation.runtime.model,
            prompt: round.aggregatorInvocation.prompt,
            result: round.aggregatorResult?.result || null,
            status: round.aggregatorResult?.status || 'error',
            error: round.aggregatorResult?.error,
          }
        : null,
    })),
  );

  writePlannerArchiveJson(archiveDir, 'final.json', {
    runId: args.runId,
    status: args.status,
    finalResult: args.finalResult,
    finalSourceRound: args.finalSourceRound || null,
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
  const rounds: PlannerExecutionRound[] = [];
  let lastCompletedRound: PlannerExecutionRound | undefined;

  logger.info(
    {
      group: group.name,
      runId,
      maxAgents: config.maxAgents,
      fixedAgents: config.fixedAgents,
      maxRounds: config.maxRounds,
    },
    'Starting planner-mode run',
  );

  for (let round = 1; round <= config.maxRounds; round++) {
    const iterativeMode = config.maxRounds > 1;
    const plannerInstanceId =
      iterativeMode && round > 1 ? `planner-round-${round}` : 'planner';
    const plannerInvocation: PlannerAgentInvocation = {
      instanceId: plannerInstanceId,
      role: 'planner',
      prompt: iterativeMode
        ? buildIterativePlannerPrompt({
            userPrompt: prompt,
            maxAgents: config.maxAgents,
            fixedAgents: config.fixedAgents,
            round,
            maxRounds: config.maxRounds,
            previousRounds: rounds,
          })
        : buildPlannerPrompt(prompt, config.maxAgents, config.fixedAgents),
      runtime: createAgentInstanceRuntime(
        group.folder,
        runId,
        plannerInstanceId,
        config.plannerModel,
      ),
    };

    const roundRecord: PlannerExecutionRound = {
      round,
      plannerInvocation,
      plannerDecision: 'error',
      workerInvocations: [],
      workerResults: [],
    };

    const plannerResult = await deps.runInstance(plannerInvocation);
    roundRecord.plannerResult = plannerResult;
    if (plannerResult.status !== 'success' || !plannerResult.result) {
      const error = plannerResult.error || 'Planner produced no usable output.';
      rounds.push(roundRecord);
      archivePlannerRun({
        group,
        chatJid,
        prompt,
        runId,
        config,
        rounds,
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
        rounds,
        error,
      };
    }

    let plan: NormalizedPlannerPlan | undefined;
    try {
      if (iterativeMode) {
        const decision = parseIterativePlannerDecision({
          raw: plannerResult.result,
          maxAgents: config.maxAgents,
          fixedAgents: config.fixedAgents,
          round,
        });
        roundRecord.plannerDecision = decision.action;
        roundRecord.plannerDecisionReason = decision.reason;

        if (decision.action === 'finalize') {
          rounds.push(roundRecord);
          if (!lastCompletedRound?.aggregatorResult?.result) {
            const error =
              'Planner chose finalize before any aggregated answer was available.';
            archivePlannerRun({
              group,
              chatJid,
              prompt,
              runId,
              config,
              rounds,
              finalResult: null,
              error,
              status: 'error',
            });
            return {
              status: 'error',
              runId,
              archiveDir,
              finalResult: null,
              plan: lastCompletedRound?.plan,
              plannerResult,
              workerResults: lastCompletedRound?.workerResults || [],
              aggregatorResult: lastCompletedRound?.aggregatorResult,
              rounds,
              error,
            };
          }

          archivePlannerRun({
            group,
            chatJid,
            prompt,
            runId,
            config,
            rounds,
            finalResult: lastCompletedRound.aggregatorResult.result,
            finalSourceRound: lastCompletedRound.round,
            status: 'success',
          });
          return {
            status: 'success',
            runId,
            archiveDir,
            finalResult: lastCompletedRound.aggregatorResult.result,
            plan: lastCompletedRound.plan,
            plannerResult,
            workerResults: lastCompletedRound.workerResults,
            aggregatorResult: lastCompletedRound.aggregatorResult,
            rounds,
          };
        }

        plan = decision.plan;
      } else {
        plan = parsePlannerPlan(
          plannerResult.result,
          config.maxAgents,
          config.fixedAgents,
        );
        roundRecord.plannerDecision = 'continue';
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      roundRecord.plannerParseError = error;
      rounds.push(roundRecord);
      archivePlannerRun({
        group,
        chatJid,
        prompt,
        runId,
        config,
        rounds,
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
        rounds,
        error,
      };
    }

    roundRecord.plan = plan;
    const workerInvocations: PlannerAgentInvocation[] = (
      plan?.agents || []
    ).map((agent, index) => {
      const instanceId =
        iterativeMode && config.maxRounds > 1
          ? `round-${round}-${agent.instanceId}`
          : agent.instanceId;
      return {
        instanceId,
        role: 'worker',
        prompt: buildPlannerWorkerPrompt(
          prompt,
          agent,
          index + 1,
          plan?.agents.length || 0,
        ),
        runtime: createAgentInstanceRuntime(
          group.folder,
          runId,
          instanceId,
          config.workerModel,
        ),
        planAgent: agent,
      };
    });
    roundRecord.workerInvocations = workerInvocations;

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
    roundRecord.workerResults = workerResults;

    const failedWorker = workerResults.find(
      (result) => result.status !== 'success' || !result.result,
    );
    if (failedWorker) {
      const error = failedWorker.error || `${failedWorker.instanceId} failed.`;
      rounds.push(roundRecord);
      archivePlannerRun({
        group,
        chatJid,
        prompt,
        runId,
        config,
        rounds,
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
        rounds,
        error,
      };
    }

    const aggregatorInstanceId =
      iterativeMode && config.maxRounds > 1
        ? `aggregator-round-${round}`
        : 'aggregator';
    const aggregatorInvocation: PlannerAgentInvocation = {
      instanceId: aggregatorInstanceId,
      role: 'aggregator',
      prompt: buildPlannerAggregatorPrompt(
        prompt,
        plan as NormalizedPlannerPlan,
        workerResults,
        iterativeMode ? round : undefined,
        iterativeMode ? config.maxRounds : undefined,
        iterativeMode ? rounds : undefined,
      ),
      runtime: createAgentInstanceRuntime(
        group.folder,
        runId,
        aggregatorInstanceId,
        config.aggregatorModel,
      ),
    };
    roundRecord.aggregatorInvocation = aggregatorInvocation;

    const aggregatorResult = await deps.runInstance(aggregatorInvocation);
    roundRecord.aggregatorResult = aggregatorResult;
    rounds.push(roundRecord);

    if (aggregatorResult.status !== 'success' || !aggregatorResult.result) {
      const error =
        aggregatorResult.error || 'Planner-mode aggregation failed.';
      archivePlannerRun({
        group,
        chatJid,
        prompt,
        runId,
        config,
        rounds,
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
        rounds,
        error,
      };
    }

    lastCompletedRound = roundRecord;

    if (round === config.maxRounds) {
      archivePlannerRun({
        group,
        chatJid,
        prompt,
        runId,
        config,
        rounds,
        finalResult: aggregatorResult.result,
        finalSourceRound: round,
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
        rounds,
      };
    }
  }

  const error = 'Planner-mode run ended without a final result.';
  archivePlannerRun({
    group,
    chatJid,
    prompt,
    runId,
    config,
    rounds,
    finalResult: null,
    error,
    status: 'error',
  });
  return {
    status: 'error',
    runId,
    archiveDir,
    finalResult: null,
    plan: lastCompletedRound?.plan,
    plannerResult: lastCompletedRound?.plannerResult,
    workerResults: lastCompletedRound?.workerResults || [],
    aggregatorResult: lastCompletedRound?.aggregatorResult,
    rounds,
    error,
  };
}
