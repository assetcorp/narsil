export type { ProcessMemoryUse } from './process-limit'

import type { ProcessMemoryUse } from './process-limit'

export function readProcessMemoryUse(): ProcessMemoryUse | null {
  return null
}

export function processLimitBytes(_processBytes: number): number {
  return 0
}
