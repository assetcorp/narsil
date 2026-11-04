import {
  UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS,
  UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS,
  UI_THREAD_TURN_BUDGET_MS,
} from './constants'
import { createWriteGate } from './write-gate'

export type ScheduleHop = (run: () => void) => void

export interface TurnScheduler {
  turnIsSpent(): boolean
  yieldTurn(): Promise<void>
  backgroundTurnIsSpent(): boolean
  yieldBackgroundTurn(): Promise<void>
  countWrite<T>(write: () => Promise<T>): Promise<T>
  holdWrites<T>(read: () => Promise<T>): Promise<T>
  holdWritesAndBackgroundWork<T>(read: () => Promise<T>): Promise<T>
  changeIndexOutsideExternalWaits<T>(change: () => Promise<T>): Promise<T>
  waitOutsideCountedWrite<T>(wait: () => Promise<T>): Promise<T>
}

export function createTurnScheduler(scheduleHop: ScheduleHop): TurnScheduler {
  const waiting: Array<() => void> = []
  const waitingInBackground: Array<() => void> = []
  let deadline = 0
  let lastWriteCheckAt = 0
  let slowestWriteUnitMs = 0
  let writeUnitRunning = false
  let lastBackgroundCheckAt = 0
  let slowestBackgroundUnitMs = 0
  let backgroundUnitRunning = false
  let turnOpen = false
  let hopScheduled = false
  let backgroundSliceStartedAt = 0
  let writesInFlight = 0
  let readsPausingBackground = 0
  let indexChangesInFlight = 0
  let backgroundThisTurn: Array<() => void> = []
  let hopGeneration = 0
  let hopFollowsYield = false
  let lastTurnWorkAt = Number.NEGATIVE_INFINITY
  const indexChangesDrained: Array<() => void> = []
  const writeGate = createWriteGate()
  const indexChangeGate = createWriteGate()

  function scheduleNextTurn(followsYield: boolean): void {
    hopGeneration += 1
    const generation = hopGeneration
    hopScheduled = true
    hopFollowsYield = followsYield
    scheduleHop(() => {
      if (generation === hopGeneration) runTurn()
    })
  }

  function requestHop(): void {
    if (!hopScheduled) scheduleNextTurn(false)
  }

  function requestHopAfterYield(): void {
    if (!hopScheduled || !hopFollowsYield) scheduleNextTurn(true)
  }

  function openTurn(now: number): void {
    turnOpen = true
    deadline = now + UI_THREAD_TURN_BUDGET_MS
    slowestWriteUnitMs = 0
    writeUnitRunning = false
    slowestBackgroundUnitMs = 0
    backgroundUnitRunning = false
    backgroundSliceStartedAt = now
    requestHop()
  }

  function startWriteUnit(now: number): void {
    lastTurnWorkAt = now
    lastWriteCheckAt = now
    writeUnitRunning = true
    backgroundUnitRunning = false
  }

  function startBackgroundUnit(now: number): void {
    lastTurnWorkAt = now
    lastBackgroundCheckAt = now
    backgroundUnitRunning = true
    writeUnitRunning = false
  }

  function keepBackgroundForNextTurn(): void {
    waitingInBackground.unshift(...backgroundThisTurn)
    backgroundThisTurn = []
  }

  function resumeWhileTurnLasts(): void {
    const now = performance.now()
    if (waiting.length > 0) {
      if (now + slowestWriteUnitMs >= deadline) {
        keepBackgroundForNextTurn()
        return
      }
      const resumeWrite = waiting.shift()
      startWriteUnit(now)
      resumeWrite?.()
      void Promise.resolve().then(resumeWhileTurnLasts)
      return
    }
    if (readsPausingBackground > 0 || now + slowestBackgroundUnitMs >= deadline) {
      keepBackgroundForNextTurn()
      return
    }
    const resumeBackground = backgroundThisTurn.shift()
    if (resumeBackground === undefined) return
    backgroundSliceStartedAt = now
    startBackgroundUnit(now)
    resumeBackground()
    void Promise.resolve().then(resumeWhileTurnLasts)
  }

  function runTurn(): void {
    hopScheduled = false
    hopFollowsYield = false
    turnOpen = false
    if (waiting.length === 0 && waitingInBackground.length === 0) return
    openTurn(performance.now())
    backgroundThisTurn = waitingInBackground.splice(0)
    resumeWhileTurnLasts()
  }

  function turnIsSpent(): boolean {
    const now = performance.now()
    if (!turnOpen) {
      if (now - lastTurnWorkAt < UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS) return true
      openTurn(now)
    }
    if (writeUnitRunning) slowestWriteUnitMs = Math.max(slowestWriteUnitMs, now - lastWriteCheckAt)
    startWriteUnit(now)
    return now + slowestWriteUnitMs >= deadline
  }

  function backgroundTurnIsSpent(): boolean {
    if (!turnOpen || readsPausingBackground > 0) return true
    const now = performance.now()
    if (backgroundUnitRunning) {
      slowestBackgroundUnitMs = Math.max(slowestBackgroundUnitMs, now - lastBackgroundCheckAt)
    }
    startBackgroundUnit(now)
    const nextUnitEndsAt = now + slowestBackgroundUnitMs
    if (nextUnitEndsAt >= deadline || waiting.length > 0) return true
    return (
      writesInFlight > 0 && nextUnitEndsAt - backgroundSliceStartedAt >= UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS
    )
  }

  function waitIn(queue: Array<() => void>): Promise<void> {
    return new Promise(resolve => {
      queue.push(resolve)
      requestHopAfterYield()
    })
  }

  async function countEnteredWrite<T>(write: () => Promise<T>): Promise<T> {
    writesInFlight += 1
    try {
      return await write()
    } finally {
      writesInFlight -= 1
    }
  }

  async function waitOutsideCountedWrite<T>(wait: () => Promise<T>): Promise<T> {
    if (writesInFlight === 0) return wait()
    writesInFlight -= 1
    try {
      return await wait()
    } finally {
      writesInFlight += 1
    }
  }

  async function countIndexChange<T>(change: () => Promise<T>): Promise<T> {
    indexChangesInFlight += 1
    try {
      return await change()
    } finally {
      indexChangesInFlight -= 1
      if (indexChangesInFlight === 0) for (const drained of indexChangesDrained.splice(0)) drained()
    }
  }

  function changeIndexOutsideExternalWaits<T>(change: () => Promise<T>): Promise<T> {
    return indexChangeGate.enter(() => countIndexChange(change))
  }

  function untilIndexChangesDrain(): Promise<void> {
    if (indexChangesInFlight === 0) return Promise.resolve()
    return new Promise(resolve => {
      indexChangesDrained.push(resolve)
    })
  }

  async function readOnceIndexChangesDrain<T>(read: () => Promise<T>): Promise<T> {
    await untilIndexChangesDrain()
    readsPausingBackground += 1
    try {
      return await read()
    } finally {
      readsPausingBackground -= 1
      if (readsPausingBackground === 0 && waitingInBackground.length > 0) requestHop()
    }
  }

  function holdWritesAndBackgroundWork<T>(read: () => Promise<T>): Promise<T> {
    return writeGate.hold(() => indexChangeGate.hold(() => readOnceIndexChangesDrain(read)))
  }

  return {
    turnIsSpent,
    yieldTurn: () => waitIn(waiting),
    backgroundTurnIsSpent,
    yieldBackgroundTurn: () => waitIn(waitingInBackground),
    countWrite: write => writeGate.enter(() => countEnteredWrite(write)),
    holdWrites: writeGate.hold,
    holdWritesAndBackgroundWork,
    changeIndexOutsideExternalWaits,
    waitOutsideCountedWrite,
  }
}
