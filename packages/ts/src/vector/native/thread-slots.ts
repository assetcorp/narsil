import { loadNativeCore } from '#platform/native-core'
import { NATIVE_THREAD_SEARCH_SLOTS, VECTOR_SCRATCH_SLOTS } from '../constants'
import { nativeSearchCoreIsEnabled } from './backend'
import type { NativeCore } from './types'

export type ThreadedNativeCore = NativeCore & Required<Pick<NativeCore, 'searchAsync' | 'scoreAsync'>>

const freeSlots: number[] = Array.from({ length: NATIVE_THREAD_SEARCH_SLOTS }, (_, i) => VECTOR_SCRATCH_SLOTS - 1 - i)
const waitingForSlot: Array<(slot: number) => void> = []

function hasNativeThreads(core: NativeCore): core is ThreadedNativeCore {
  return core.searchAsync !== undefined && core.scoreAsync !== undefined
}

export function threadedNativeCore(): ThreadedNativeCore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  return core !== null && hasNativeThreads(core) ? core : null
}

function claimSlot(): Promise<number> {
  const slot = freeSlots.pop()
  if (slot !== undefined) return Promise.resolve(slot)
  return new Promise(resolve => waitingForSlot.push(resolve))
}

function returnSlot(slot: number): void {
  const next = waitingForSlot.shift()
  if (next !== undefined) {
    next(slot)
    return
  }
  freeSlots.push(slot)
}

export async function withNativeThreadSlot<T>(work: (slot: number) => Promise<T>): Promise<T> {
  const slot = await claimSlot()
  try {
    return await work(slot)
  } finally {
    returnSlot(slot)
  }
}
