import type { MutationRecord } from './types'

const deferred = new WeakSet<MutationRecord>()

export function deferMutationPublication(record: MutationRecord): void {
  deferred.add(record)
}

export function hasDeferredPublication(record: MutationRecord): boolean {
  return deferred.has(record)
}
