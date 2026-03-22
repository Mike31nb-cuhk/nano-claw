import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { runContainerAgent } from './container-runner.js';
import {
  AgentRuntimeScope,
  resolveAgentRuntimeScope,
  resolveGroupFolderPath,
  resolveInstanceIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const INTERNAL_BLOCK_RE = /<internal>[\s\S]*?<\/internal>/g;
const DEFAULT_VOTING_WORKER_COUNT = 3;
const MAX_VOTING_WORKER_COUNT = 10;

export interface VotingWorkerResult {
  instanceId: string;
  output: string;
}

export interface VotingRunResult {
  runId: string;
  workerCount: number;
  runDir: string;
  workerResults: VotingWorkerResult[];
  finalOutput: string;
}

export function getInteractionMode(group: RegisteredGroup): 'single' | 'vote' {
  return group.containerConfig?.interactionMode === 'vote' ? 'vote' : 'single';
}

export function getVotingWorkerCount(group: RegisteredGroup): number {
  const configured = group.containerConfig?.workerCount;
  if (
    typeof configured === 'number' &&
    Number.isInteger(configured) &&
    configured >= 1 &&
    configured <= MAX_VOTING_WORKER_COUNT
  ) {
    return configured;
  }
  return DEFAULT_VOTING_WORKER_COUNT;
}

function createVotingRunId(): string {
  return `vote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanAgentOutput(text: string): string {
  return text.replace(INTERNAL_BLOCK_RE, '').trim();
}

function writeTextFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content.endsWith('\n') ? content : `${content}\n`);
}

function writeJsonFile(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2) + '\n');
}

function signalInstanceClose(scope: AgentRuntimeScope): void {
  const inputDir = path.join(resolveInstanceIpcPath(scope), 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}

function buildWorkerPrompt(
  userPrompt: string,
  workerIndex: number,
  workerCount: number,
): string {
  return [
    `You are worker ${workerIndex} of ${workerCount} in a voting-style multi-agent run.`,
    `Produce your own best answer independently.`,
    `Do not mention voting, hidden workers, or internal orchestration in your reply.`,
    '',
    'User request:',
    userPrompt,
  ].join('\n');
}

function buildAggregatorPrompt(
  userPrompt: string,
  workerResults: VotingWorkerResult[],
): string {
  const sections = workerResults.map(
    (worker) => `[${worker.instanceId}]\n${worker.output}`,
  );
  return [
    'You are the aggregator for a voting-style multi-agent run.',
    'Read the original request and the independent worker answers.',
    'Produce a single final answer for the user.',
    'Use the strongest parts of the worker answers, resolve disagreements, and do not mention the hidden voting process.',
    '',
    'Original user request:',
    userPrompt,
    '',
    'Worker answers:',
    sections.join('\n\n'),
  ].join('\n');
}

async function runSingleVotingAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  runId: string,
  instanceId: string,
): Promise<string> {
  const runtimeScope = resolveAgentRuntimeScope(group.folder, runId, instanceId);
  let latestOutput: string | null = null;
  let closeSignalled = false;

  const output = await runContainerAgent(
    group,
    {
      prompt,
      groupFolder: group.folder,
      runId,
      instanceId,
      chatJid,
      isMain: group.isMain === true,
      assistantName: ASSISTANT_NAME,
    },
    () => {
      // No queue registration here: the swarm is orchestrated inside one group-level turn.
    },
    async (streamedOutput) => {
      if (!streamedOutput.result) return;
      const raw =
        typeof streamedOutput.result === 'string'
          ? streamedOutput.result
          : JSON.stringify(streamedOutput.result);
      const cleaned = cleanAgentOutput(raw);
      if (!cleaned) return;
      latestOutput = cleaned;
      if (!closeSignalled) {
        signalInstanceClose(runtimeScope);
        closeSignalled = true;
      }
    },
  );

  if (output.status === 'error' && !latestOutput) {
    throw new Error(output.error || `${instanceId} failed with no output`);
  }

  if (output.result && !latestOutput) {
    const raw =
      typeof output.result === 'string'
        ? output.result
        : JSON.stringify(output.result);
    latestOutput = cleanAgentOutput(raw);
  }

  if (!latestOutput) {
    throw new Error(`${instanceId} completed without producing an answer`);
  }

  return latestOutput;
}

export async function runVotingSwarm(
  group: RegisteredGroup,
  userPrompt: string,
  chatJid: string,
): Promise<VotingRunResult> {
  const workerCount = getVotingWorkerCount(group);
  const runId = createVotingRunId();
  const runDir = path.join(resolveGroupFolderPath(group.folder), 'runs', runId);
  const workersDir = path.join(runDir, 'workers');

  writeTextFile(path.join(runDir, 'prompt.md'), userPrompt);
  logger.info(
    { group: group.name, runId, workerCount },
    'Starting voting swarm run',
  );

  const workerResults = await Promise.all(
    Array.from({ length: workerCount }, async (_value, index) => {
      const instanceId = `worker-${index + 1}`;
      const output = await runSingleVotingAgent(
        group,
        buildWorkerPrompt(userPrompt, index + 1, workerCount),
        chatJid,
        runId,
        instanceId,
      );
      writeTextFile(path.join(workersDir, `${instanceId}.md`), output);
      return { instanceId, output };
    }),
  );

  const finalOutput = await runSingleVotingAgent(
    group,
    buildAggregatorPrompt(userPrompt, workerResults),
    chatJid,
    runId,
    'aggregator',
  );

  writeTextFile(path.join(runDir, 'final.md'), finalOutput);
  writeJsonFile(path.join(runDir, 'manifest.json'), {
    mode: 'vote',
    runId,
    workerCount,
    createdAt: new Date().toISOString(),
    workerResults: workerResults.map((worker) => ({
      instanceId: worker.instanceId,
      file: `workers/${worker.instanceId}.md`,
      chars: worker.output.length,
    })),
    finalFile: 'final.md',
  });

  logger.info(
    { group: group.name, runId, workerCount },
    'Voting swarm run completed',
  );

  return {
    runId,
    workerCount,
    runDir,
    workerResults,
    finalOutput,
  };
}
