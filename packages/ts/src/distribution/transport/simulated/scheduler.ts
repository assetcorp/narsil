export interface ScheduledEvent {
  deliverAt: number
  run: () => void | Promise<void>
}

interface HeapEntry extends ScheduledEvent {
  id: number
}

export interface SchedulerRunOptions {
  maxEvents?: number
  quietMs?: number
  tickMs?: number
}

export interface DeterministicSchedulerConfig {
  startTime: number
  advanceTimers: (ms: number) => Promise<unknown>
}

export interface DeterministicScheduler {
  readonly now: number
  readonly pendingCount: number
  enqueue(event: ScheduledEvent): number
  step(): Promise<boolean>
  runUntilQuiet(options?: SchedulerRunOptions): Promise<void>
  runWithDrain<T>(fn: () => Promise<T>, options?: SchedulerRunOptions): Promise<T>
  advanceBy(ms: number): Promise<void>
  dispose(): void
}

const DEFAULT_MAX_EVENTS = 5_000
const DEFAULT_QUIET_MS = 1_200
const DEFAULT_TICK_MS = 50
const DRAIN_TICK_BUDGET = 2_000

export function createDeterministicScheduler(config: DeterministicSchedulerConfig): DeterministicScheduler {
  const heap: HeapEntry[] = []
  let nextId = 0
  let currentTime = config.startTime
  let disposed = false
  const advanceTimers = config.advanceTimers

  function compare(a: HeapEntry, b: HeapEntry): number {
    if (a.deliverAt !== b.deliverAt) {
      return a.deliverAt - b.deliverAt
    }
    return a.id - b.id
  }

  function heapPush(entry: HeapEntry): void {
    heap.push(entry)
    let idx = heap.length - 1
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1
      if (compare(heap[idx], heap[parentIdx]) >= 0) {
        break
      }
      const tmp = heap[idx]
      heap[idx] = heap[parentIdx]
      heap[parentIdx] = tmp
      idx = parentIdx
    }
  }

  function heapPop(): HeapEntry | undefined {
    if (heap.length === 0) {
      return undefined
    }
    const top = heap[0]
    const last = heap.pop()
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last
      siftDown(0)
    }
    return top
  }

  function siftDown(start: number): void {
    let idx = start
    const length = heap.length
    while (true) {
      let smallest = idx
      const left = 2 * idx + 1
      const right = 2 * idx + 2
      if (left < length && compare(heap[left], heap[smallest]) < 0) {
        smallest = left
      }
      if (right < length && compare(heap[right], heap[smallest]) < 0) {
        smallest = right
      }
      if (smallest === idx) {
        break
      }
      const tmp = heap[idx]
      heap[idx] = heap[smallest]
      heap[smallest] = tmp
      idx = smallest
    }
  }

  async function step(): Promise<boolean> {
    if (disposed) {
      return false
    }
    const event = heapPop()
    if (event === undefined) {
      return false
    }
    if (event.deliverAt > currentTime) {
      const delta = event.deliverAt - currentTime
      currentTime = event.deliverAt
      await advanceTimers(delta)
    }
    await event.run()
    await advanceTimers(0)
    return true
  }

  async function runUntilQuiet(options?: SchedulerRunOptions): Promise<void> {
    const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS
    const quietMs = options?.quietMs ?? DEFAULT_QUIET_MS
    const tickMs = options?.tickMs ?? DEFAULT_TICK_MS

    let deliveredEvents = 0
    let quietElapsed = 0

    while (deliveredEvents < maxEvents && quietElapsed < quietMs && !disposed) {
      if (heap.length > 0) {
        quietElapsed = 0
        const delivered = await step()
        if (delivered) {
          deliveredEvents++
        }
        continue
      }
      currentTime += tickMs
      quietElapsed += tickMs
      await advanceTimers(tickMs)
      await advanceTimers(0)
      if (heap.length > 0) {
        quietElapsed = 0
      }
    }
  }

  async function runWithDrain<T>(fn: () => Promise<T>, options?: SchedulerRunOptions): Promise<T> {
    const tickMs = options?.tickMs ?? DEFAULT_TICK_MS
    let fnSettled = false
    const fnPromise = fn().finally(() => {
      fnSettled = true
    })
    fnPromise.catch(() => undefined)

    await runUntilQuiet(options)

    let extraTicks = 0
    while (!fnSettled && !disposed && extraTicks < DRAIN_TICK_BUDGET) {
      currentTime += tickMs
      await advanceTimers(tickMs)
      await advanceTimers(0)
      while (heap.length > 0 && !disposed) {
        await step()
      }
      extraTicks++
    }

    return fnPromise
  }

  return {
    get now(): number {
      return currentTime
    },

    get pendingCount(): number {
      return heap.length
    },

    enqueue(event: ScheduledEvent): number {
      if (disposed) {
        return -1
      }
      const id = nextId++
      heapPush({ deliverAt: event.deliverAt, run: event.run, id })
      return id
    },

    step,

    runUntilQuiet,

    runWithDrain,

    async advanceBy(ms: number): Promise<void> {
      if (disposed) {
        return
      }
      currentTime += ms
      await advanceTimers(ms)
      await advanceTimers(0)
    },

    dispose(): void {
      disposed = true
      heap.length = 0
    },
  }
}
