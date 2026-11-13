import { readProcessMemoryUse } from '#platform/process-limit'
import { FROZEN_REMOVAL_MAX_PROCESS_FRACTION } from '../partition/constants'

export function processHasRoomFor(bytes: number): boolean {
  const memory = readProcessMemoryUse()
  if (memory === null) return true
  return memory.processBytes + bytes <= FROZEN_REMOVAL_MAX_PROCESS_FRACTION * memory.limitBytes
}
