import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isProcessAlive } from './listener-ownership.js';

const execFileAsync = promisify(execFile);

export interface StaleListener {
  port: number;
  pid: number;
  ppid?: number;
  /** True when the listener's parent is gone: an MCP server whose client died without closing stdio. */
  orphan: boolean;
}

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (file, args) =>
  execFileAsync(file, args, { windowsHide: true, timeout: 5_000 });

/** Pid holding a LISTEN socket on host:port, or undefined. */
export async function listeningPid(
  port: number,
  platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<number | undefined> {
  if (platform === 'win32') {
    const { stdout } = await exec('netstat', ['-ano', '-p', 'TCP']);
    for (const line of stdout.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`)) {
        return Number(cols[4]);
      }
    }
    return undefined;
  }
  const { stdout } = await exec('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']).catch(() => ({
    stdout: '',
  }));
  const pid = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

export async function parentPid(
  pid: number,
  platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<number | undefined> {
  const args =
    platform === 'win32'
      ? [
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
          ],
        ]
      : ['ps', ['-o', 'ppid=', '-p', String(pid)]];
  const { stdout } = await exec(args[0] as string, args[1] as string[]).catch(() => ({
    stdout: '',
  }));
  const ppid = Number(stdout.trim());
  return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
}

/**
 * Bridge listeners in the scan range that belong to other processes.
 * `orphan` marks the ones whose parent process is dead: safe to stop.
 */
export async function findStaleBridgeListeners(options: {
  host: string;
  ports: number[];
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  selfPid?: number;
  alive?: (pid: number) => boolean;
}): Promise<StaleListener[]> {
  const { ports, platform = process.platform, exec = defaultExec } = options;
  const selfPid = options.selfPid ?? process.pid;
  const alive = options.alive ?? isProcessAlive;
  const out: StaleListener[] = [];
  // ponytail: one netstat per port is fine for a 10-port range; batch if the range ever grows.
  for (const port of ports) {
    const pid = await listeningPid(port, platform, exec);
    if (!pid || pid === selfPid) continue;
    const ppid = await parentPid(pid, platform, exec);
    const orphan = ppid === undefined ? false : ppid <= 1 || !alive(ppid);
    out.push({ port, pid, ppid, orphan });
  }
  return out;
}

/** Stop orphaned listeners. Returns the pids that were signalled. */
export function killStaleListeners(
  listeners: StaleListener[],
  kill: (pid: number) => void = (pid) => process.kill(pid),
): number[] {
  const killed: number[] = [];
  for (const l of listeners) {
    if (!l.orphan) continue;
    try {
      kill(l.pid);
      killed.push(l.pid);
    } catch {
      // already gone
    }
  }
  return killed;
}
