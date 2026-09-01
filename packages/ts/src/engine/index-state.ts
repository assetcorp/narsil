import { ErrorCodes, NarsilError } from '../errors'
import type { IndexLifecycleConfig } from '../types/config'

const DEFAULT_MAX_REOPEN_WAITERS = 64
const MAX_REOPEN_FAILURES = 5
const MIN_SWEEP_INTERVAL_MS = 100
const MAX_SWEEP_INTERVAL_MS = 60_000

type LifecycleState = 'open' | 'closed' | 'closing' | 'dropping' | 'reopen-failed'

interface LifecycleEntry {
  state: LifecycleState
  lastAccessAt: number
  activeOperations: number
  reopenCount: number
  reopenFailures: number
  nextReopenAt: number
  cachedError: NarsilError | null
  reopenPromise: Promise<void> | null
  waiterCount: number
  closePromise: Promise<void> | null
  dropPromise: Promise<void> | null
  drainResolvers: Set<() => void>
}

export interface IndexStateCallbacks {
  reopen(indexName: string): Promise<void>
  close(indexName: string): Promise<void>
  canCloseAutomatically(indexName: string): boolean
  estimateBytes(indexName: string): number
}

export interface IndexStateCoordinator {
  registerOpen(indexName: string): Promise<void>
  registerClosed(indexName: string): void
  forget(indexName: string): void
  acquire(indexName: string, markActive?: boolean): Promise<() => void>
  open(indexName: string): Promise<void>
  close(indexName: string): Promise<void>
  drop(indexName: string, action: () => Promise<void>): Promise<void>
  stateOf(indexName: string): 'open' | 'closed' | 'reopen-failed'
  reopenCount(indexName: string): number
  counts(): { open: number; closed: number; reopens: number }
  dispose(): void
}

function validateLimit(name: string, value: number | undefined, allowZero = false): void {
  if (value === undefined) return
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum) {
    const requirement = allowZero ? 'a non-negative safe integer' : 'a positive safe integer'
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `${name} must be ${requirement}`, {
      field: name,
      value,
    })
  }
}

function cachedRecoveryError(error: unknown, indexName: string): NarsilError {
  if (error instanceof NarsilError) return error
  return new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Index "${indexName}" could not be reopened`, {
    indexName,
    cause: error instanceof Error ? error.message : String(error),
  })
}

/**
 * Builds the bounded state machine that opens and closes durable indexes.
 *
 * @param config - Limits that trigger automatic closes.
 * @param callbacks - Storage and memory operations owned by the engine.
 * @returns The lifecycle coordinator.
 */
export function createIndexStateCoordinator(
  config: IndexLifecycleConfig | undefined,
  callbacks: IndexStateCallbacks,
): IndexStateCoordinator {
  validateLimit('lifecycle.idleTimeoutMs', config?.idleTimeoutMs)
  validateLimit('lifecycle.maxOpenIndexes', config?.maxOpenIndexes)
  validateLimit('lifecycle.maxOpenBytes', config?.maxOpenBytes)
  validateLimit('lifecycle.maxReopenWaiters', config?.maxReopenWaiters, true)

  const entries = new Map<string, LifecycleEntry>()
  const waiterLimit = config?.maxReopenWaiters ?? DEFAULT_MAX_REOPEN_WAITERS
  let sweepTimer: ReturnType<typeof setInterval> | null = null

  function entryOf(indexName: string): LifecycleEntry {
    const entry = entries.get(indexName)
    if (entry === undefined) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
    }
    return entry
  }

  function publicState(entry: LifecycleEntry): 'open' | 'closed' | 'reopen-failed' {
    return entry.state === 'closing' || entry.state === 'dropping' ? 'open' : entry.state
  }

  async function waitForDrain(entry: LifecycleEntry): Promise<void> {
    if (entry.activeOperations === 0) return
    await new Promise<void>(resolve => entry.drainResolvers.add(resolve))
  }

  function releaseEntry(entry: LifecycleEntry): void {
    entry.activeOperations -= 1
    if (entry.activeOperations !== 0) return
    for (const resolve of entry.drainResolvers) resolve()
    entry.drainResolvers.clear()
  }

  async function waitForTransition(indexName: string, entry: LifecycleEntry, transition: Promise<void>): Promise<void> {
    if (entry.waiterCount >= waiterLimit) {
      throw new NarsilError(
        ErrorCodes.INDEX_REOPEN_CAPACITY_EXHAUSTED,
        `Index "${indexName}" has reached its reopen waiter limit`,
        { indexName, maximum: waiterLimit },
      )
    }
    entry.waiterCount += 1
    try {
      await transition
    } finally {
      entry.waiterCount -= 1
    }
  }

  async function reopen(indexName: string, explicit: boolean): Promise<void> {
    let entry = entryOf(indexName)
    if (entry.state === 'dropping' && entry.dropPromise !== null) {
      await entry.dropPromise
      entry = entryOf(indexName)
    }
    if (entry.state === 'open') return
    if (entry.state === 'closing' && entry.closePromise !== null) {
      await waitForTransition(indexName, entry, entry.closePromise)
    }
    if (explicit) {
      entry.reopenFailures = 0
      entry.nextReopenAt = 0
      entry.cachedError = null
      if (entry.state === 'reopen-failed') entry.state = 'closed'
    }
    if (entry.state === 'reopen-failed') throw entry.cachedError
    if (entry.reopenPromise !== null) {
      await waitForTransition(indexName, entry, entry.reopenPromise)
      return
    }
    if (!explicit && entry.cachedError !== null && Date.now() < entry.nextReopenAt) {
      throw entry.cachedError
    }

    const run = callbacks
      .reopen(indexName)
      .then(() => {
        entry.state = 'open'
        entry.reopenCount += 1
        entry.reopenFailures = 0
        entry.nextReopenAt = 0
        entry.cachedError = null
      })
      .catch(error => {
        entry.reopenFailures += 1
        entry.cachedError = cachedRecoveryError(error, indexName)
        entry.nextReopenAt = Date.now() + 100 * 2 ** (entry.reopenFailures - 1)
        entry.state = entry.reopenFailures >= MAX_REOPEN_FAILURES ? 'reopen-failed' : 'closed'
        throw entry.cachedError
      })
      .finally(() => {
        entry.reopenPromise = null
      })
    entry.reopenPromise = run
    await run
  }

  async function closeEntry(indexName: string, automatic: boolean): Promise<boolean> {
    let entry = entryOf(indexName)
    if (entry.state === 'dropping' && entry.dropPromise !== null) {
      if (automatic) return false
      await entry.dropPromise
      entry = entryOf(indexName)
    }
    if (entry.reopenPromise !== null) {
      if (automatic) return false
      await entry.reopenPromise
    }
    if (entry.state === 'closed' || entry.state === 'reopen-failed') return true
    if (entry.state === 'closing' && entry.closePromise !== null) {
      if (!automatic) await entry.closePromise
      return !automatic
    }
    if (automatic && (entry.activeOperations > 0 || !callbacks.canCloseAutomatically(indexName))) return false

    entry.state = 'closing'
    const run = (async () => {
      await waitForDrain(entry)
      await callbacks.close(indexName)
      entry.state = 'closed'
      entry.cachedError = null
      entry.reopenFailures = 0
    })()
      .catch(error => {
        entry.state = 'open'
        throw error
      })
      .finally(() => {
        entry.closePromise = null
      })
    entry.closePromise = run
    if (automatic) {
      await run.catch(() => undefined)
      return publicState(entry) === 'closed'
    }
    await run
    return true
  }

  async function dropEntry(indexName: string, action: () => Promise<void>): Promise<void> {
    const entry = entryOf(indexName)
    if (entry.dropPromise !== null) {
      await entry.dropPromise
      return
    }
    if (entry.reopenPromise !== null) await entry.reopenPromise
    if (entry.closePromise !== null) await entry.closePromise
    const previousState = entry.state
    entry.state = 'dropping'
    const run = (async () => {
      await waitForDrain(entry)
      await action()
      entries.delete(indexName)
    })()
      .catch(error => {
        entry.state = previousState
        throw error
      })
      .finally(() => {
        entry.dropPromise = null
      })
    entry.dropPromise = run
    await run
  }

  function exceedsLimits(): boolean {
    let open = 0
    let bytes = 0
    for (const [name, entry] of entries) {
      if (entry.state !== 'open') continue
      open += 1
      bytes += callbacks.estimateBytes(name)
    }
    return (
      (config?.maxOpenIndexes !== undefined && open > config.maxOpenIndexes) ||
      (config?.maxOpenBytes !== undefined && bytes > config.maxOpenBytes)
    )
  }

  async function enforceLimits(protectedName?: string): Promise<void> {
    if (config?.maxOpenIndexes === undefined && config?.maxOpenBytes === undefined) return
    while (exceedsLimits()) {
      const candidates = [...entries]
        .filter(([name, entry]) => name !== protectedName && entry.state === 'open' && entry.activeOperations === 0)
        .sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt)
      const candidate = candidates[0]
      if (candidate === undefined || !(await closeEntry(candidate[0], true))) return
    }
  }

  async function sweep(): Promise<void> {
    const timeout = config?.idleTimeoutMs
    if (timeout !== undefined && timeout > 0) {
      const cutoff = Date.now() - timeout
      for (const [name, entry] of entries) {
        if (entry.state === 'open' && entry.lastAccessAt <= cutoff) await closeEntry(name, true)
      }
    }
    await enforceLimits()
  }

  if (config !== undefined) {
    const requested = config.idleTimeoutMs === undefined ? MAX_SWEEP_INTERVAL_MS : config.idleTimeoutMs / 2
    const interval = Math.min(MAX_SWEEP_INTERVAL_MS, Math.max(MIN_SWEEP_INTERVAL_MS, requested))
    sweepTimer = setInterval(() => void sweep().catch(() => undefined), interval)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  }

  return {
    async registerOpen(indexName: string): Promise<void> {
      entries.set(indexName, {
        state: 'open',
        lastAccessAt: Date.now(),
        activeOperations: 0,
        reopenCount: 0,
        reopenFailures: 0,
        nextReopenAt: 0,
        cachedError: null,
        reopenPromise: null,
        waiterCount: 0,
        closePromise: null,
        dropPromise: null,
        drainResolvers: new Set(),
      })
      await enforceLimits(indexName)
    },
    registerClosed(indexName: string): void {
      entries.set(indexName, {
        state: 'closed',
        lastAccessAt: Date.now(),
        activeOperations: 0,
        reopenCount: 0,
        reopenFailures: 0,
        nextReopenAt: 0,
        cachedError: null,
        reopenPromise: null,
        waiterCount: 0,
        closePromise: null,
        dropPromise: null,
        drainResolvers: new Set(),
      })
    },
    forget(indexName: string): void {
      entries.delete(indexName)
    },
    async acquire(indexName: string, markActive = true): Promise<() => void> {
      const entry = entryOf(indexName)
      const opened = entry.state !== 'open'
      await reopen(indexName, false)
      while (entry.state !== 'open') await reopen(indexName, false)
      if (markActive) entry.lastAccessAt = Date.now()
      entry.activeOperations += 1
      try {
        if (opened) await enforceLimits(indexName)
      } catch (error) {
        releaseEntry(entry)
        throw error
      }
      let released = false
      return () => {
        if (released) return
        released = true
        releaseEntry(entry)
      }
    },
    async open(indexName: string): Promise<void> {
      await reopen(indexName, true)
      const entry = entryOf(indexName)
      while (entry.state !== 'open') await reopen(indexName, true)
      entry.lastAccessAt = Date.now()
      entry.activeOperations += 1
      try {
        await enforceLimits(indexName)
      } finally {
        releaseEntry(entry)
      }
    },
    async close(indexName: string): Promise<void> {
      await closeEntry(indexName, false)
    },
    drop(indexName: string, action: () => Promise<void>): Promise<void> {
      return dropEntry(indexName, action)
    },
    stateOf(indexName: string): 'open' | 'closed' | 'reopen-failed' {
      return publicState(entryOf(indexName))
    },
    reopenCount(indexName: string): number {
      return entryOf(indexName).reopenCount
    },
    counts(): { open: number; closed: number; reopens: number } {
      let open = 0
      let closed = 0
      let reopens = 0
      for (const entry of entries.values()) {
        if (entry.state === 'open' || entry.state === 'closing') open += 1
        else closed += 1
        reopens += entry.reopenCount
      }
      return { open, closed, reopens }
    },
    dispose(): void {
      if (sweepTimer !== null) clearInterval(sweepTimer)
      sweepTimer = null
      entries.clear()
    },
  }
}
