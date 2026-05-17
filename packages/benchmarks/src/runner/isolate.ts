import { type ChildProcess, fork } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FailureCode, FailureRecord } from './error-records'
import { isJobOutcome, type JobSpec, type JobSuccess } from './jobs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000
const DEFAULT_MAX_OLD_SPACE_MB = 8192

export interface IsolateOptions {
  timeoutMs?: number
  maxOldSpaceMb?: number
  workerScript?: string
  inheritStdio?: boolean
}

export interface IsolateResult {
  outcome: JobSuccess | { kind: 'failure'; failure: FailureRecord }
}

interface InternalEnd {
  ended: boolean
  result: IsolateResult | null
}

function resolveWorkerScript(override?: string): string {
  if (override !== undefined && override.length > 0) return override
  return resolve(__dirname, 'worker.ts')
}

function buildExecArgv(maxOldSpaceMb: number, workerScript: string): string[] {
  const argv = ['--expose-gc', `--max-old-space-size=${maxOldSpaceMb}`]
  if (workerScript.endsWith('.ts')) {
    argv.push('--import', 'tsx')
  }
  return argv
}

function failureFromExit(
  job: JobSpec,
  code: FailureCode,
  message: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): FailureRecord {
  const failure: FailureRecord = {
    code,
    message,
    phase: jobPhase(job),
    engine: job.engine,
    exitCode,
    signal,
  }
  if ('scale' in job && typeof job.scale === 'number') failure.scale = job.scale
  if ('dimension' in job && typeof job.dimension === 'number') failure.dimension = job.dimension
  return failure
}

function jobPhase(job: JobSpec): FailureRecord['phase'] {
  switch (job.kind) {
    case 'text':
      return 'text-tier'
    case 'vector':
      return 'vector-tier'
    case 'serialization':
      return 'serialization-tier'
    case 'mutation':
      return 'mutation-tier'
    case 'quality':
      return 'quality-tier'
    case 'cranfield':
      return 'cranfield-tier'
  }
}

function attachLifecycle(
  child: ChildProcess,
  job: JobSpec,
  state: InternalEnd,
  resolveDone: (value: IsolateResult) => void,
  timer: NodeJS.Timeout,
): void {
  const settle = (result: IsolateResult): void => {
    if (state.ended) return
    state.ended = true
    state.result = result
    clearTimeout(timer)
    if (child.connected) {
      try {
        child.disconnect()
      } catch {
        /* disconnect may already have happened */
      }
    }
    resolveDone(result)
  }

  child.on('message', (raw: unknown) => {
    if (state.ended) return
    if (!isJobOutcome(raw)) {
      settle({
        outcome: {
          kind: 'failure',
          failure: failureFromExit(job, 'engine-ipc-corrupt', 'worker sent an unrecognised message', null, null),
        },
      })
      return
    }
    if (raw.kind === 'error') {
      settle({
        outcome: {
          kind: 'failure',
          failure: failureFromExit(job, 'engine-threw', raw.message, null, null),
        },
      })
      return
    }
    settle({ outcome: raw })
  })

  child.on('exit', (exitCode, signal) => {
    if (state.ended) return
    if (exitCode === 0 && signal === null) {
      settle({
        outcome: {
          kind: 'failure',
          failure: failureFromExit(
            job,
            'engine-disconnect',
            'worker exited 0 without sending a result',
            exitCode,
            signal,
          ),
        },
      })
      return
    }
    if (signal !== null) {
      settle({
        outcome: {
          kind: 'failure',
          failure: failureFromExit(job, 'engine-signal', `worker terminated by signal ${signal}`, exitCode, signal),
        },
      })
      return
    }
    settle({
      outcome: {
        kind: 'failure',
        failure: failureFromExit(job, 'engine-exited', `worker exited with code ${exitCode}`, exitCode, signal),
      },
    })
  })

  child.on('error', err => {
    if (state.ended) return
    settle({
      outcome: {
        kind: 'failure',
        failure: failureFromExit(job, 'engine-threw', `failed to spawn worker: ${err.message}`, null, null),
      },
    })
  })
}

function killWorker(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* the child may already have exited between the killed check and the kill call */
  }
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* same reasoning as above */
      }
    }
  }, 5_000).unref?.()
}

export async function runInIsolation(job: JobSpec, options: IsolateOptions = {}): Promise<IsolateResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOldSpaceMb = options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB
  const workerScript = resolveWorkerScript(options.workerScript)
  const execArgv = buildExecArgv(maxOldSpaceMb, workerScript)
  const stdio = options.inheritStdio === false ? 'ignore' : 'inherit'

  return new Promise<IsolateResult>(resolveDone => {
    const state: InternalEnd = { ended: false, result: null }
    let child: ChildProcess
    try {
      child = fork(workerScript, [], {
        execArgv,
        stdio: [stdio, stdio, stdio, 'ipc'],
        env: { ...process.env, NARSIL_BENCH_WORKER: '1' },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      resolveDone({
        outcome: {
          kind: 'failure',
          failure: failureFromExit(job, 'engine-threw', `fork failed: ${message}`, null, null),
        },
      })
      return
    }

    const timer = setTimeout(() => {
      if (state.ended) return
      killWorker(child)
      const failure = failureFromExit(job, 'engine-timeout', `worker exceeded ${timeoutMs}ms`, null, null)
      state.ended = true
      resolveDone({ outcome: { kind: 'failure', failure } })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    attachLifecycle(child, job, state, resolveDone, timer)

    try {
      child.send(job, sendErr => {
        if (sendErr && !state.ended) {
          killWorker(child)
          state.ended = true
          clearTimeout(timer)
          resolveDone({
            outcome: {
              kind: 'failure',
              failure: failureFromExit(job, 'engine-threw', `failed to send job: ${sendErr.message}`, null, null),
            },
          })
        }
      })
    } catch (err) {
      if (!state.ended) {
        killWorker(child)
        state.ended = true
        clearTimeout(timer)
        const message = err instanceof Error ? err.message : String(err)
        resolveDone({
          outcome: {
            kind: 'failure',
            failure: failureFromExit(job, 'engine-threw', `send threw: ${message}`, null, null),
          },
        })
      }
    }
  })
}
