import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export const DEFAULT_RUN_ID = 'default-run';
export const DEFAULT_INSTANCE_ID = 'default';

export interface AgentRuntimeScope {
  groupFolder: string;
  runId: string;
  instanceId: string;
}

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

export function isValidRuntimeId(id: string): boolean {
  if (!id) return false;
  if (id !== id.trim()) return false;
  if (!RUNTIME_ID_PATTERN.test(id)) return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id.includes('..')) return false;
  return true;
}

function assertValidRuntimeId(kind: 'run' | 'instance', id: string): void {
  if (!isValidRuntimeId(id)) {
    throw new Error(`Invalid ${kind} id "${id}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveDefaultAgentRuntimeScope(
  groupFolder: string,
): AgentRuntimeScope {
  return resolveAgentRuntimeScope(
    groupFolder,
    DEFAULT_RUN_ID,
    DEFAULT_INSTANCE_ID,
  );
}

export function resolveAgentRuntimeScope(
  groupFolder: string,
  runId = DEFAULT_RUN_ID,
  instanceId = DEFAULT_INSTANCE_ID,
): AgentRuntimeScope {
  assertValidGroupFolder(groupFolder);
  assertValidRuntimeId('run', runId);
  assertValidRuntimeId('instance', instanceId);
  return { groupFolder, runId, instanceId };
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

export function resolveGroupSessionsPath(folder: string): string {
  assertValidGroupFolder(folder);
  const sessionsBaseDir = path.resolve(DATA_DIR, 'sessions');
  const sessionsPath = path.resolve(sessionsBaseDir, folder);
  ensureWithinBase(sessionsBaseDir, sessionsPath);
  return sessionsPath;
}

export function resolveRunIpcPath(scope: AgentRuntimeScope): string {
  const runtimeScope = resolveAgentRuntimeScope(
    scope.groupFolder,
    scope.runId,
    scope.instanceId,
  );
  const runPath = path.resolve(
    resolveGroupIpcPath(runtimeScope.groupFolder),
    'runs',
    runtimeScope.runId,
  );
  ensureWithinBase(resolveGroupIpcPath(runtimeScope.groupFolder), runPath);
  return runPath;
}

export function resolveInstanceIpcPath(scope: AgentRuntimeScope): string {
  const runtimeScope = resolveAgentRuntimeScope(
    scope.groupFolder,
    scope.runId,
    scope.instanceId,
  );
  const instancePath = path.resolve(
    resolveRunIpcPath(runtimeScope),
    'instances',
    runtimeScope.instanceId,
  );
  ensureWithinBase(resolveGroupIpcPath(runtimeScope.groupFolder), instancePath);
  return instancePath;
}

export function resolveRunSessionsPath(scope: AgentRuntimeScope): string {
  const runtimeScope = resolveAgentRuntimeScope(
    scope.groupFolder,
    scope.runId,
    scope.instanceId,
  );
  const runPath = path.resolve(
    resolveGroupSessionsPath(runtimeScope.groupFolder),
    'runs',
    runtimeScope.runId,
  );
  ensureWithinBase(
    resolveGroupSessionsPath(runtimeScope.groupFolder),
    runPath,
  );
  return runPath;
}

export function resolveInstanceSessionRootPath(scope: AgentRuntimeScope): string {
  const runtimeScope = resolveAgentRuntimeScope(
    scope.groupFolder,
    scope.runId,
    scope.instanceId,
  );
  const instancePath = path.resolve(
    resolveRunSessionsPath(runtimeScope),
    'instances',
    runtimeScope.instanceId,
  );
  ensureWithinBase(
    resolveGroupSessionsPath(runtimeScope.groupFolder),
    instancePath,
  );
  return instancePath;
}

export function resolveInstanceClaudePath(scope: AgentRuntimeScope): string {
  return path.join(resolveInstanceSessionRootPath(scope), '.claude');
}

export function resolveInstanceAgentRunnerSrcPath(
  scope: AgentRuntimeScope,
): string {
  return path.join(resolveInstanceSessionRootPath(scope), 'agent-runner-src');
}

export function resolveLegacyGroupClaudePath(groupFolder: string): string {
  return path.join(resolveGroupSessionsPath(groupFolder), '.claude');
}

export function resolveLegacyGroupAgentRunnerSrcPath(
  groupFolder: string,
): string {
  return path.join(resolveGroupSessionsPath(groupFolder), 'agent-runner-src');
}

export function buildSessionScopeKey(scope: AgentRuntimeScope): string {
  const runtimeScope = resolveAgentRuntimeScope(
    scope.groupFolder,
    scope.runId,
    scope.instanceId,
  );
  return [
    runtimeScope.groupFolder,
    runtimeScope.runId,
    runtimeScope.instanceId,
  ].join('::');
}
