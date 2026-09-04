import { ErrorCodes, NarsilError } from '../../errors'

export type LifecycleState = 'open' | 'closed' | 'closing' | 'dropping' | 'reopen-failed'

export interface LifecycleEntry {
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
  close(indexName: string, markIrreversible: () => void): Promise<void>
  onAccess?(indexName: string): void
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

export function createLifecycleEntry(state: 'open' | 'closed'): LifecycleEntry {
  return {
    state,
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
  }
}

export function validateLimit(name: string, value: number | undefined, allowZero = false): void {
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

export function cachedRecoveryError(error: unknown, indexName: string): NarsilError {
  if (error instanceof NarsilError) return error
  return new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Index "${indexName}" could not be reopened`, {
    indexName,
    cause: error instanceof Error ? error.message : String(error),
  })
}
