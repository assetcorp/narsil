import { ErrorCodes, NarsilError } from '../../errors'
import { ANALYSIS_HOLD_APPLY_INTERVAL_MS } from '../constants'
import type { EngineCore } from '../core'
import type { AnalysisTarget } from './settings'

export interface ChangeRun {
  target: AnalysisTarget
  stopReason: NarsilError | null
  switched: boolean
  settled: Promise<void>
  finish(): void
  fail(error: unknown): void
  finished: Promise<void>
  hold: ChangeHold | null
}

export interface ChangeHold {
  generation: number
  built: boolean
  released: boolean
  ready: Promise<void>
  markReady(): void
  refuse(error: unknown): void
  wake(): void
  pause(): Promise<void>
}

export function createHold(generation: number): ChangeHold {
  let markReady: () => void = () => undefined
  let refuse: (error: unknown) => void = () => undefined
  let wake: () => void = () => undefined
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    refuse = reject
  })
  ready.catch(() => undefined)
  return {
    generation,
    built: false,
    released: false,
    ready,
    markReady,
    refuse,
    wake: () => wake(),
    pause: () =>
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ANALYSIS_HOLD_APPLY_INTERVAL_MS)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      }),
  }
}

const runsByCore = new WeakMap<EngineCore, Map<string, ChangeRun>>()

export function runsOf(core: EngineCore): Map<string, ChangeRun> {
  let runs = runsByCore.get(core)
  if (runs === undefined) {
    runs = new Map()
    runsByCore.set(core, runs)
  }
  return runs
}

export function createRun(target: AnalysisTarget, hold: ChangeHold | null = null): ChangeRun & { settle(): void } {
  let finish: () => void = () => undefined
  let rejectFinished: (error: unknown) => void = () => undefined
  let settle: () => void = () => undefined
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve
    rejectFinished = reject
  })
  finished.catch(() => undefined)
  const settled = new Promise<void>(resolve => {
    settle = resolve
  })
  const fail = (error: unknown): void => {
    rejectFinished(error)
    hold?.refuse(error)
    hold?.wake()
  }
  return { target, stopReason: null, switched: false, settled, finish, fail, finished, settle, hold }
}

export async function waitForRelease(run: ChangeRun, hold: ChangeHold, keepCurrent: () => boolean): Promise<boolean> {
  hold.built = true
  hold.markReady()
  while (!hold.released) {
    if (run.stopReason !== null || !keepCurrent()) {
      hold.built = false
      return false
    }
    await hold.pause()
  }
  return true
}

export function stopRun(run: ChangeRun, indexName: string): void {
  run.stopReason = new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_REPLACED,
    `A later change or a restore replaced this analysis change of index "${indexName}"`,
    { indexName },
  )
  run.fail(run.stopReason)
}
