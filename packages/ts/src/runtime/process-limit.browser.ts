export type { ResidentMemory } from './process-limit'

import type { ResidentMemory } from './process-limit'

export function readResidentMemory(): ResidentMemory | null {
  return null
}

export function processLimitBytes(_residentBytes: number): number {
  return 0
}
