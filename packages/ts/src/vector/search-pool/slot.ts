import { noteThreadSlotGone, noteThreadSlotLive } from '../../workers/thread-slot'
import type { SharedGraphHandles } from '../hnsw/handles'
import { releaseLocksHeldBy } from '../hnsw/locks'
import type { VectorWorkerMessage } from './messages'
import type { WorkerHandle } from './spawn'

export interface PendingRequest {
  resolve(message: VectorWorkerMessage): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface WorkerSlot {
  worker: WorkerHandle
  scratchSlot: number
  pending: Map<string, PendingRequest>
  alive: boolean
  outstanding: number
  graphs: Map<string, SharedGraphHandles>
  working: Map<string, string>
  idleWaiters: Set<() => void>
}

export function createSlot(worker: WorkerHandle, scratchSlot: number): WorkerSlot {
  noteThreadSlotLive(scratchSlot)
  return {
    worker,
    scratchSlot,
    pending: new Map(),
    alive: true,
    outstanding: 0,
    graphs: new Map(),
    working: new Map(),
    idleWaiters: new Set(),
  }
}

export function noteGraphOpened(slot: WorkerSlot, handle: string, graph: SharedGraphHandles | null): void {
  if (graph !== null) slot.graphs.set(handle, graph)
}

export function noteWorkStarted(slot: WorkerSlot, requestId: string, handle: string): void {
  slot.working.set(requestId, handle)
}

function stillWorkingOn(slot: WorkerSlot, handle: string): boolean {
  for (const working of slot.working.values()) if (working === handle) return true
  return false
}

export function forgetDroppedGraphs(slot: WorkerSlot, shared: ReadonlyMap<string, unknown>): void {
  for (const handle of [...slot.graphs.keys()]) {
    if (!shared.has(handle) && !stillWorkingOn(slot, handle)) slot.graphs.delete(handle)
  }
}

export function noteAnswered(slot: WorkerSlot, requestId: string, shared: ReadonlyMap<string, unknown>): void {
  if (!slot.working.delete(requestId)) return
  forgetDroppedGraphs(slot, shared)
  if (slot.working.size > 0) return
  for (const waiter of [...slot.idleWaiters]) waiter()
}

export function untilIdle(slot: WorkerSlot, deadlineMs: number): Promise<void> {
  if (slot.working.size === 0) return Promise.resolve()
  return new Promise(resolve => {
    const finish = (): void => {
      clearTimeout(timer)
      slot.idleWaiters.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, deadlineMs)
    slot.idleWaiters.add(finish)
  })
}

export function releaseSlotLocks(slot: WorkerSlot): void {
  noteThreadSlotGone(slot.scratchSlot)
  for (const graph of slot.graphs.values()) releaseLocksHeldBy(graph, slot.scratchSlot)
  slot.graphs.clear()
  slot.working.clear()
  for (const waiter of [...slot.idleWaiters]) waiter()
}

export function rejectPending(slot: WorkerSlot, err: Error): void {
  for (const [, waiting] of slot.pending) {
    clearTimeout(waiting.timer)
    waiting.reject(err)
  }
  slot.pending.clear()
}
