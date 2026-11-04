import {
  HEAP_BLOCK_FRACTION_BELOW_V8_INEFFECTIVE_MARK_COMPACT_LINE,
  HEAP_RESUME_FRACTION_BELOW_V8_INEFFECTIVE_MARK_COMPACT_LINE,
} from '../../runtime/constants'
import { DEFAULT_BLOCK_WRITES_ABOVE, DEFAULT_RESUME_WRITES_BELOW } from './constants'

export interface MemoryFractionSettings {
  blockWritesAbove?: number
  resumeWritesBelow?: number
}

export interface MemoryFractions {
  processBlock: number
  processResume: number
  heapBlock: number
  heapResume: number
}

export function memoryFractionsOf(config: MemoryFractionSettings | undefined): MemoryFractions {
  const block = config?.blockWritesAbove ?? DEFAULT_BLOCK_WRITES_ABOVE
  const resume = config?.resumeWritesBelow ?? DEFAULT_RESUME_WRITES_BELOW
  return {
    processBlock: block,
    processResume: resume,
    heapBlock: Math.min(block, HEAP_BLOCK_FRACTION_BELOW_V8_INEFFECTIVE_MARK_COMPACT_LINE),
    heapResume: Math.min(resume, HEAP_RESUME_FRACTION_BELOW_V8_INEFFECTIVE_MARK_COMPACT_LINE),
  }
}
