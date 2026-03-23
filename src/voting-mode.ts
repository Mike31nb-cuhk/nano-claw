import fs from 'fs';
import path from 'path';

import {
  AgentInstanceRuntime,
  createAgentInstanceRuntime,
} from './container-runner.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, VotingConfig } from './types.js';

const DEFAULT_WORKER_COUNT = 3;
const DEFAULT_MIN_SUCCESSES = 1;
const MAX_VOTING_WORKERS = 5;
const HAN_SCRIPT_REGEX = /[\u3400-\u9fff]/;

export interface ResolvedVotingConfig {
  enabled: boolean;
  workerCount: number;
  minSuccesses: number;
  workerModel?: string;
  aggregatorModel?: string;
}

export interface VotingAgentInvocation {
  instanceId: string;
  role: 'worker' | 'aggregator';
  prompt: string;
  runtime: AgentInstanceRuntime;
}

export interface VotingAgentResult {
  instanceId: string;
  role: 'worker' | 'aggregator';
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

export interface VotingModeDeps {
  runInstance: (invocation: VotingAgentInvocation) => Promise<VotingAgentResult>;
}

export interface VotingModeResult {
  status: 'success' | 'error';
  runId: string;
  archiveDir: string;
  finalResult: string | null;
  workerResults: VotingAgentResult[];
  aggregatorResult?: VotingAgentResult;
  usedFallback: boolean;
  error?: string;
}

function isLikelyChinese(text: string): boolean {
  return HAN_SCRIPT_REGEX.test(text);
}

function extractWorkerCandidate(result: string | null | undefined): string | null {
  if (!result) return null;

  const lines = result
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const candidateMatch = line.match(/^Candidate:\s*(.+)$/i);
    if (candidateMatch?.[1]) {
      return candidateMatch[1].trim();
    }

    const zhAnswerMatch = line.match(/^答案[:：]\s*(.+)$/);
    if (zhAnswerMatch?.[1]) {
      return zhAnswerMatch[1].trim();
    }
  }

  return lines[0] || null;
}

export function resolveVotingConfig(
  config?: VotingConfig,
): ResolvedVotingConfig {
  const enabled = config?.enabled === true;
  const workerCount = Math.max(
    1,
    Math.min(config?.workerCount || DEFAULT_WORKER_COUNT, MAX_VOTING_WORKERS),
  );
  const minSuccesses = Math.max(
    1,
    Math.min(config?.minSuccesses || DEFAULT_MIN_SUCCESSES, workerCount),
  );

  return {
    enabled,
    workerCount,
    minSuccesses,
    workerModel: config?.workerModel,
    aggregatorModel: config?.aggregatorModel,
  };
}

export function createVotingRunId(): string {
  return `vote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildVotingWorkerPrompt(
  userPrompt: string,
  workerIndex: number,
  workerCount: number,
): string {
  return [
    'You are participating in a voting-style multi-agent run inside NanoClaw.',
    `You are worker ${workerIndex} of ${workerCount}.`,
    'Solve the request independently and give your own best answer.',
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

export function buildAggregatorPrompt(
  userPrompt: string,
  workerResults: VotingAgentResult[],
): string {
  const useChinese = isLikelyChinese(userPrompt);
  const runnerHeading = useChinese ? 'Runner 回答' : 'Runner Summary';
  const finalHeading = useChinese ? '最终答案' : 'Final Answer';
  const whyHeading = useChinese ? '为什么' : 'Why';
  const sections = workerResults.map((result, index) =>
    [
      `Worker ${index + 1} (${result.instanceId})`,
      result.result || '[no result]',
    ].join('\n'),
  );
  const candidateLines = workerResults.map((result, index) => {
    const candidate =
      extractWorkerCandidate(result.result) ||
      (useChinese ? '未明确给出候选答案' : 'No explicit candidate');
    return `${index + 1}. Worker ${index + 1}: ${candidate}`;
  });

  if (useChinese) {
    return [
      '你是 NanoClaw 投票模式中的 aggregator。',
      '你的任务是先清楚列出每个 runner 的候选答案，再给出最终投票结论。',
      '不要一上来就说“几个答案都有道理”。先逐个列出 runner 的答案，再做判断。',
      '即使多个答案都部分成立，也必须选出一个最适合作为最终回答的答案。',
      '除非确有必要，不要解释内部多 Agent 编排过程。',
      '你的回答必须严格按下面顺序输出：',
      `## ${runnerHeading}`,
      '1. Runner 1：<一句话概括它的答案>',
      '2. Runner 2：<一句话概括它的答案>',
      '3. 按顺序继续，覆盖所有成功 runner',
      '',
      `## ${finalHeading}`,
      '第一句话直接给出投票后的最终答案；接着用一小段自然语言展开，不要绕弯子。',
      '',
      `## ${whyHeading}`,
      '- 用 2 到 4 条短 bullet 解释为什么选这个答案',
      '- 如有分歧，顺手说明其他 runner 为什么没被选中',
      '',
      '原始用户请求：',
      userPrompt,
      '',
      '已提取的 runner 候选答案：',
      candidateLines.join('\n'),
      '',
      '完整 worker 输出：',
      sections.join('\n\n'),
    ].join('\n');
  }

  return [
    'You are the aggregator in a voting-style multi-agent run inside NanoClaw.',
    'Your job is to first list each runner\'s proposed answer clearly, then produce one voted final answer for the user.',
    'Prefer correctness, specificity, and usefulness over consensus.',
    'Do not open with "multiple answers are reasonable" before you enumerate the runners.',
    'If the workers disagree, resolve the conflict and briefly note uncertainty only when it materially matters.',
    'Even if several answers are partially valid, you must still choose the one that best fits the user request.',
    'Do not mention internal orchestration unless it helps the user.',
    'Use the same language as the user request unless there is a strong reason not to.',
    'You must use this output structure:',
    `1. A section titled \`${runnerHeading}\` with one numbered line per worker, each line naming that worker's proposed answer in a short phrase.`,
    `2. A section titled \`${finalHeading}\` where the first sentence directly states the chosen answer.`,
    `3. A section titled \`${whyHeading}\` with 2 to 4 short bullet points explaining why that answer was chosen and how disagreements were resolved.`,
    'Keep the result concise and readable.',
    '',
    'Original user request:',
    userPrompt,
    '',
    'Extracted runner candidates:',
    candidateLines.join('\n'),
    '',
    'Worker outputs:',
    sections.join('\n\n'),
  ].join('\n');
}

export function pickVotingFallback(
  workerResults: VotingAgentResult[],
): string | null {
  return pickVotingFallbackResult(workerResults)?.result || null;
}

export function pickVotingFallbackResult(
  workerResults: VotingAgentResult[],
): VotingAgentResult | null {
  const successful = workerResults
    .filter(
      (result) => result.status === 'success' && result.result && result.result,
    )
    .sort((a, b) => (b.result?.length || 0) - (a.result?.length || 0));

  return successful[0] || null;
}

function getVotingArchiveDir(groupFolder: string, runId: string): string {
  return path.join(resolveGroupIpcPath(groupFolder), 'runs', runId, 'results');
}

function writeVotingArchiveJson(
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

function archiveVotingRun(args: {
  group: RegisteredGroup;
  chatJid: string;
  prompt: string;
  runId: string;
  config: ResolvedVotingConfig;
  workerInvocations: VotingAgentInvocation[];
  workerResults: VotingAgentResult[];
  aggregatorInvocation?: VotingAgentInvocation;
  aggregatorResult?: VotingAgentResult;
  finalResult: string | null;
  usedFallback: boolean;
  error?: string;
  status: 'success' | 'error';
}): string {
  const archiveDir = getVotingArchiveDir(args.group.folder, args.runId);
  const archivedAt = new Date().toISOString();
  const fallbackResult = args.usedFallback
    ? pickVotingFallbackResult(args.workerResults)
    : null;

  writeVotingArchiveJson(archiveDir, 'request.json', {
    runId: args.runId,
    groupFolder: args.group.folder,
    groupName: args.group.name,
    chatJid: args.chatJid,
    prompt: args.prompt,
    config: args.config,
    archivedAt,
  });

  writeVotingArchiveJson(archiveDir, 'run.json', {
    runId: args.runId,
    groupFolder: args.group.folder,
    groupName: args.group.name,
    status: args.status,
    usedFallback: args.usedFallback,
    error: args.error,
    workerCount: args.workerInvocations.length,
    successfulWorkers: args.workerResults.filter(
      (result) => result.status === 'success' && result.result,
    ).length,
    workerCandidates: args.workerResults.map((result) => ({
      instanceId: result.instanceId,
      candidate: extractWorkerCandidate(result.result),
      status: result.status,
    })),
    archivedAt,
  });

  for (const invocation of args.workerInvocations) {
    const workerResult = args.workerResults.find(
      (result) => result.instanceId === invocation.instanceId,
    );
    writeVotingArchiveJson(archiveDir, `${invocation.instanceId}.json`, {
      runId: args.runId,
      instanceId: invocation.instanceId,
      role: invocation.role,
      model: invocation.runtime.model,
      candidate: extractWorkerCandidate(workerResult?.result),
      prompt: invocation.prompt,
      runtime: invocation.runtime,
      result: workerResult?.result || null,
      status: workerResult?.status || 'error',
      error: workerResult?.error,
      archivedAt,
    });
  }

  if (args.aggregatorInvocation || args.aggregatorResult) {
    writeVotingArchiveJson(archiveDir, 'aggregator.json', {
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

  writeVotingArchiveJson(archiveDir, 'final.json', {
    runId: args.runId,
    status: args.status,
    finalResult: args.finalResult,
    usedFallback: args.usedFallback,
    finalSourceInstanceId: args.usedFallback
      ? fallbackResult?.instanceId || null
      : args.aggregatorResult?.instanceId || null,
    workerCandidates: args.workerResults.map((result) => ({
      instanceId: result.instanceId,
      candidate: extractWorkerCandidate(result.result),
      status: result.status,
    })),
    error: args.error,
    archivedAt,
  });

  return archiveDir;
}

export async function runVotingMode(args: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  deps: VotingModeDeps;
}): Promise<VotingModeResult> {
  const { group, prompt, chatJid, deps } = args;
  const config = resolveVotingConfig(group.containerConfig?.voting);
  const runId = createVotingRunId();
  const archiveDir = getVotingArchiveDir(group.folder, runId);

  const workerInvocations: VotingAgentInvocation[] = Array.from(
    { length: config.workerCount },
    (_, index) => {
      const workerNumber = index + 1;
      const instanceId = `worker-${workerNumber}`;
      return {
        instanceId,
        role: 'worker',
        prompt: buildVotingWorkerPrompt(prompt, workerNumber, config.workerCount),
        runtime: createAgentInstanceRuntime(
          group.folder,
          runId,
          instanceId,
          config.workerModel,
        ),
      };
    },
  );

  logger.info(
    {
      group: group.name,
      runId,
      workerCount: workerInvocations.length,
      minSuccesses: config.minSuccesses,
    },
    'Starting voting-mode run',
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
    } satisfies VotingAgentResult;
  });

  const successfulWorkers = workerResults.filter(
    (result) => result.status === 'success' && result.result,
  );

  if (successfulWorkers.length < config.minSuccesses) {
    archiveVotingRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      workerInvocations,
      workerResults,
      finalResult: null,
      usedFallback: false,
      error: `Only ${successfulWorkers.length} worker(s) succeeded; need at least ${config.minSuccesses}.`,
      status: 'error',
    });
    return {
      status: 'error',
      runId,
      archiveDir,
      finalResult: null,
      workerResults,
      usedFallback: false,
      error: `Only ${successfulWorkers.length} worker(s) succeeded; need at least ${config.minSuccesses}.`,
    };
  }

  const aggregatorInvocation: VotingAgentInvocation = {
    instanceId: 'aggregator',
    role: 'aggregator',
    prompt: buildAggregatorPrompt(prompt, successfulWorkers),
    runtime: createAgentInstanceRuntime(
      group.folder,
      runId,
      'aggregator',
      config.aggregatorModel,
    ),
  };

  const aggregatorResult = await deps.runInstance(aggregatorInvocation);
  if (aggregatorResult.status === 'success' && aggregatorResult.result) {
    archiveVotingRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      workerInvocations,
      workerResults,
      aggregatorInvocation,
      aggregatorResult,
      finalResult: aggregatorResult.result,
      usedFallback: false,
      status: 'success',
    });
    return {
      status: 'success',
      runId,
      archiveDir,
      finalResult: aggregatorResult.result,
      workerResults,
      aggregatorResult,
      usedFallback: false,
    };
  }

  const fallbackResult = pickVotingFallbackResult(successfulWorkers);
  const fallback = fallbackResult?.result || null;
  if (fallback) {
    archiveVotingRun({
      group,
      chatJid,
      prompt,
      runId,
      config,
      workerInvocations,
      workerResults,
      aggregatorInvocation,
      aggregatorResult,
      finalResult: fallback,
      usedFallback: true,
      error: aggregatorResult.error,
      status: 'success',
    });
    return {
      status: 'success',
      runId,
      archiveDir,
      finalResult: fallback,
      workerResults,
      aggregatorResult,
      usedFallback: true,
      error: aggregatorResult.error,
    };
  }

  archiveVotingRun({
    group,
    chatJid,
    prompt,
    runId,
    config,
    workerInvocations,
    workerResults,
    aggregatorInvocation,
    aggregatorResult,
    finalResult: null,
    usedFallback: false,
    error: aggregatorResult.error || 'Voting-mode aggregation failed.',
    status: 'error',
  });
  return {
    status: 'error',
    runId,
    archiveDir,
    finalResult: null,
    workerResults,
    aggregatorResult,
    usedFallback: false,
    error: aggregatorResult.error || 'Voting-mode aggregation failed.',
  };
}
