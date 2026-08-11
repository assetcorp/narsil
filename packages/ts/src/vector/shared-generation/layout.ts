import type { SharedGenerationLayout } from './types'

export const WASM_PAGE_BYTES = 65536

const MAX_WASM_PAGES = 65536
const SCRATCH_ALIGNMENT = 16

function alignUp(bytes: number): number {
  return Math.ceil(bytes / SCRATCH_ALIGNMENT) * SCRATCH_ALIGNMENT
}

/**
 * Computes where each region of a frozen generation sits inside one shared
 * memory, or null when the total would pass what a 32-bit memory can address.
 *
 * @param dimension The number of components per vector.
 * @param slots The number of ordinals the arenas span.
 * @param workerSlots The number of per-worker scratch slot pairs to reserve.
 * @param withCodes Whether to reserve the quantised code arena.
 * @returns The layout, or null when it cannot fit.
 *
 * @internal
 */
export function computeSharedGenerationLayout(
  dimension: number,
  slots: number,
  workerSlots: number,
  withCodes: boolean,
): SharedGenerationLayout | null {
  if (dimension <= 0 || slots <= 0 || workerSlots <= 0) return null

  const float32ScratchStride = Math.max(SCRATCH_ALIGNMENT, alignUp(dimension * 4))
  const codeScratchStride = Math.max(SCRATCH_ALIGNMENT, alignUp(dimension))
  const codeScratchOffset = workerSlots * float32ScratchStride
  const vectorsOffset = alignUp(codeScratchOffset + workerSlots * codeScratchStride)
  const codesOffset = alignUp(vectorsOffset + slots * dimension * 4)
  const dataEnd = codesOffset + (withCodes ? slots * dimension : 0)

  const pages = Math.ceil(dataEnd / WASM_PAGE_BYTES)
  if (pages > MAX_WASM_PAGES) return null

  return {
    dimension,
    slots,
    workerSlots,
    float32ScratchStride,
    codeScratchStride,
    codeScratchOffset,
    vectorsOffset,
    codesOffset,
    totalBytes: pages * WASM_PAGE_BYTES,
  }
}
