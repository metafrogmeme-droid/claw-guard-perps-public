// Deadline watchdogs that do not depend on the main loop making progress.
//
// Soft: a timer on the main event loop. A loop stuck on an await (a call that never settles) does not block the
// event loop, so this timer still fires; it aborts the run's AbortSignal, every bounded await rejects at once,
// and the runner goes to its close-out.
//
// Deadline watchdog (deadlineWatchdog, used by the session runner): like the soft one, plus a wall-clock tick, so
// it also fires after the box was paused, and a stall check (no loop progress for stallSec).
//
// Hard backstop: a worker thread with its own event loop. It fires even if the main thread is stuck in
// synchronous code. It writes a line to the status file saying the close-out did not finish and the account
// must be flattened with `kill`, then ends the whole process with SIGKILL (exit status 137, never 0).
import { Worker } from 'node:worker_threads';

export interface SoftWatchdog {
  /** True once the watchdog has fired. */
  readonly fired: boolean;
  cancel(): void;
}

/** Calls `onFire` once after `ms` unless cancelled. Does not keep the process alive. */
export function softWatchdog(ms: number, onFire: () => void): SoftWatchdog {
  let fired = false;
  const t = setTimeout(
    () => {
      fired = true;
      onFire();
    },
    Math.max(0, ms),
  );
  t.unref();
  return {
    get fired() {
      return fired;
    },
    cancel: () => {
      clearTimeout(t);
    },
  };
}

export interface DeadlineWatchdogOptions {
  /** Session deadline, wall-clock seconds (same clock as `now`). */
  readonly deadline: number;
  /** Fire this long after the deadline if the loop is still running, seconds. */
  readonly graceSec: number;
  /** Wall clock, seconds. */
  readonly now: () => number;
  /** Fire when the loop has made no progress (see `progress()`) for this long, wall-clock seconds. 0 = off. */
  readonly stallSec: number;
  /** How often the watchdog looks at the wall clock, ms. Default 5000. */
  readonly tickMs?: number;
  /** Process (monotonic) clock in ms, used to notice wall-clock jumps (e.g. performance.now). Omit = no jump check. */
  readonly monoMs?: () => number;
  /** A wall-clock jump this much larger than the process clock is reported, seconds. Default 30. */
  readonly jumpSec?: number;
  readonly onFire: (why: string) => void;
  /** Called when the wall clock moved `jumpSec` or more past the process clock between two ticks. */
  readonly onClockJump?: (sec: number) => void;
}

export interface DeadlineWatchdog extends SoftWatchdog {
  /** Why it fired ('deadline watchdog' or 'loop stalled ...'), once it has. */
  readonly reason: string | undefined;
  /** Wall-clock jumps seen (count, largest in seconds). */
  readonly jumps: { readonly count: number; readonly maxSec: number };
  /** The loop calls this whenever it makes progress (a call settled, a wait ended). */
  progress(): void;
  /** Runs one check now (the timer calls it every tickMs). */
  check(): void;
}

/**
 * Deadline and stall watchdog on the wall clock.
 *
 * Why not one setTimeout: Node timers run on the process (monotonic) clock. When the box is paused (VM freeze,
 * host suspend) the wall clock keeps going but the process clock does not, so a one-shot timer set for
 * "deadline + grace" fires that much process time later, which can be long after the real deadline. On 4 Nov
 * the evening session froze from ~21:03 to ~22:18 CET; the deadline watchdog (and the separate watcher process)
 * never fired and only SIGTERM closed it out. This watchdog instead ticks every few seconds and compares the
 * wall clock with the deadline and with the last loop progress, so the first tick after the box resumes stops
 * the loop and the close-out runs. It also keeps the one-shot timer as a fallback.
 */
export function deadlineWatchdog(o: DeadlineWatchdogOptions): DeadlineWatchdog {
  const mono = o.monoMs ?? ((): number => 0);
  const jumpCheck = o.monoMs !== undefined;
  const jumpSec = o.jumpSec ?? 30;
  let fired = false;
  let reason: string | undefined;
  let lastProgress = o.now();
  let lastWall = o.now();
  let lastMono = mono();
  const jumps = { count: 0, maxSec: 0 };
  const fire = (why: string): void => {
    if (fired) return;
    fired = true;
    reason = why;
    stopTimers();
    o.onFire(why);
  };
  const check = (): void => {
    if (fired) return;
    const wall = o.now();
    const m = mono();
    const gap = wall - lastWall - (m - lastMono) / 1000;
    if (jumpCheck && gap >= jumpSec) {
      jumps.count += 1;
      jumps.maxSec = Math.max(jumps.maxSec, Math.round(gap));
      o.onClockJump?.(Math.round(gap));
    }
    lastWall = wall;
    lastMono = m;
    if (wall >= o.deadline + o.graceSec) {
      fire('deadline watchdog');
      return;
    }
    const quiet = wall - lastProgress;
    if (o.stallSec > 0 && quiet >= o.stallSec) {
      fire(`loop stalled: no progress for ${String(Math.round(quiet))} s`);
    }
  };
  const tick = setInterval(check, Math.max(10, o.tickMs ?? 5_000));
  tick.unref();
  const once = setTimeout(
    () => {
      fire('deadline watchdog');
    },
    Math.max(0, (o.deadline - o.now() + o.graceSec) * 1000),
  );
  once.unref();
  function stopTimers(): void {
    clearInterval(tick);
    clearTimeout(once);
  }
  return {
    get fired() {
      return fired;
    },
    get reason() {
      return reason;
    },
    get jumps() {
      return { ...jumps };
    },
    progress: () => {
      lastProgress = o.now();
    },
    check,
    cancel: stopTimers,
  };
}

/** Source of the backstop worker. Plain JS so it runs without a TypeScript loader. */
export const BACKSTOP_WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const t = setTimeout(() => {
  const line = JSON.stringify({
    state: 'watchdog hard stop: close-out did not finish; account may NOT be flat, run kill',
    at: Math.floor(Date.now() / 1000),
    reason: workerData.reason,
  });
  try { fs.appendFileSync(workerData.statusPath, line + '\\n'); } catch {}
  try { process.stderr.write(line + '\\n'); } catch {}
  process.kill(process.pid, 'SIGKILL');
}, workerData.ms);
parentPort.on('message', (m) => { if (m === 'cancel') { clearTimeout(t); process.exit(0); } });
`;

export interface HardBackstop {
  cancel(): Promise<void>;
}

/**
 * Starts the backstop worker: after `ms` it appends a line to `statusPath` and SIGKILLs this process.
 * `cancel()` stops it (call it once the run has written its report).
 */
export function hardBackstop(ms: number, statusPath: string, reason: string): HardBackstop {
  const w = new Worker(BACKSTOP_WORKER_SOURCE, {
    eval: true,
    workerData: { ms: Math.max(0, ms), statusPath, reason },
  });
  w.unref();
  return {
    cancel: async () => {
      w.postMessage('cancel');
      await w.terminate();
    },
  };
}
