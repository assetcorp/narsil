import type { prepareFrozenStrings as PrepareFrozenStringsCode } from './removal-strings'
import type { GrowFrozenRemovalRegions, PrepareFrozenRemoval, RemoveFrozenDocument, SettleFrozenState } from './types'

export interface FrozenRemovalKernel {
  growFrozenRemovalRegions: GrowFrozenRemovalRegions
  removeFrozenDocument: RemoveFrozenDocument
  prepareFrozenRemoval: PrepareFrozenRemoval
  prepareFrozenStrings: typeof PrepareFrozenStringsCode
  settleFrozenState: SettleFrozenState
}

let bound: FrozenRemovalKernel | null = null

export function bindFrozenRemovalKernel(kernel: FrozenRemovalKernel): void {
  bound = kernel
}

function kernel(): FrozenRemovalKernel {
  if (bound === null) throw new Error('The engine reached write code before it loaded that code')
  return bound
}

export const growFrozenRemovalRegions: GrowFrozenRemovalRegions = (...args) =>
  kernel().growFrozenRemovalRegions(...args)

export const removeFrozenDocument: RemoveFrozenDocument = (...args) => kernel().removeFrozenDocument(...args)

export const prepareFrozenRemoval: PrepareFrozenRemoval = (...args) => kernel().prepareFrozenRemoval(...args)

export const prepareFrozenStrings: typeof PrepareFrozenStringsCode = (...args) => kernel().prepareFrozenStrings(...args)

export const settleFrozenState: SettleFrozenState = (...args) => kernel().settleFrozenState(...args)
