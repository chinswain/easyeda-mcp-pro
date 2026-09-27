import { describe, expect, it } from 'vitest';
import {
  findStaleBridgeListeners,
  killStaleListeners,
  listeningPid,
  parentPid,
  type ExecFn,
} from '../../../src/bridge/stale-listeners.js';

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:49620        0.0.0.0:0              LISTENING       1111
  TCP    127.0.0.1:49626        0.0.0.0:0              LISTENING       2222
  TCP    127.0.0.1:49620        127.0.0.1:50000        ESTABLISHED     1111
`;

const winExec: ExecFn = async (file, args) => {
  if (file === 'netstat') return { stdout: NETSTAT };
  const pid = /ProcessId=(\d+)/.exec(args[2] ?? '')?.[1];
  return { stdout: pid === '1111' ? '99\n' : '5\n' };
};

describe('stale bridge listeners', () => {
  it('parses win32 netstat and PowerShell parent pids', async () => {
    expect(await listeningPid(49620, 'win32', winExec)).toBe(1111);
    expect(await listeningPid(49621, 'win32', winExec)).toBeUndefined();
    expect(await parentPid(1111, 'win32', winExec)).toBe(99);
  });

  it('parses unix lsof and ps output', async () => {
    const exec: ExecFn = async (file) => ({ stdout: file === 'lsof' ? '4242\n' : '  1\n' });
    expect(await listeningPid(49620, 'linux', exec)).toBe(4242);
    expect(await parentPid(4242, 'linux', exec)).toBe(1);
  });

  it('flags listeners whose parent is dead as orphans and skips itself', async () => {
    const found = await findStaleBridgeListeners({
      host: '127.0.0.1',
      ports: [49620, 49626, 49627],
      platform: 'win32',
      exec: winExec,
      selfPid: 2222,
      alive: (pid) => pid === 99,
    });
    expect(found).toEqual([{ port: 49620, pid: 1111, ppid: 99, orphan: false }]);

    const orphaned = await findStaleBridgeListeners({
      host: '127.0.0.1',
      ports: [49620, 49626],
      platform: 'win32',
      exec: winExec,
      selfPid: 1,
      alive: () => false,
    });
    expect(orphaned.map((l) => [l.pid, l.orphan])).toEqual([
      [1111, true],
      [2222, true],
    ]);
  });

  it('kills only orphans and tolerates already-gone pids', () => {
    const killed: number[] = [];
    const result = killStaleListeners(
      [
        { port: 49620, pid: 1, orphan: true },
        { port: 49621, pid: 2, orphan: false },
        { port: 49622, pid: 3, orphan: true },
      ],
      (pid) => {
        if (pid === 3) throw new Error('ESRCH');
        killed.push(pid);
      },
    );
    expect(killed).toEqual([1]);
    expect(result).toEqual([1]);
  });
});
