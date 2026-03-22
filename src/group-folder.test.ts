import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildSessionScopeKey,
  DEFAULT_INSTANCE_ID,
  DEFAULT_RUN_ID,
  isValidGroupFolder,
  isValidRuntimeId,
  resolveAgentRuntimeScope,
  resolveDefaultAgentRuntimeScope,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveInstanceClaudePath,
  resolveInstanceIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('validates run and instance ids', () => {
    expect(isValidRuntimeId('run-01')).toBe(true);
    expect(isValidRuntimeId('instance.alpha')).toBe(true);
    expect(isValidRuntimeId('../escape')).toBe(false);
    expect(isValidRuntimeId('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('resolves default runtime scope for legacy single-agent flows', () => {
    expect(resolveDefaultAgentRuntimeScope('family-chat')).toEqual({
      groupFolder: 'family-chat',
      runId: DEFAULT_RUN_ID,
      instanceId: DEFAULT_INSTANCE_ID,
    });
  });

  it('resolves instance-specific IPC and session paths', () => {
    const scope = resolveAgentRuntimeScope(
      'family-chat',
      'run-alpha',
      'worker-1',
    );
    expect(resolveInstanceIpcPath(scope)).toContain(
      `${path.sep}family-chat${path.sep}runs${path.sep}run-alpha${path.sep}instances${path.sep}worker-1`,
    );
    expect(resolveInstanceClaudePath(scope)).toContain(
      `${path.sep}sessions${path.sep}family-chat${path.sep}runs${path.sep}run-alpha${path.sep}instances${path.sep}worker-1${path.sep}.claude`,
    );
  });

  it('builds stable session scope keys', () => {
    const key = buildSessionScopeKey(
      resolveAgentRuntimeScope('family-chat', 'run-alpha', 'worker-1'),
    );
    expect(key).toBe('family-chat::run-alpha::worker-1');
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
    expect(() => resolveAgentRuntimeScope('family-chat', '../run')).toThrow();
  });
});
