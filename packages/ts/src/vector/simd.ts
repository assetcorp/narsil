import type { VectorMetric } from './brute-force'
import { SIMD_DISTANCE_SHARED_MEMORY_WASM_BASE64, SIMD_DISTANCE_WASM_BASE64 } from './simd-wasm-binary'

interface SimdExports {
  memory: WebAssembly.Memory
  dot_product: (ptrA: number, ptrB: number, len: number) => number
  magnitude: (ptr: number, len: number) => number
  squared_euclidean_distance: (ptrA: number, ptrB: number, len: number) => number
  euclidean_distance: (ptrA: number, ptrB: number, len: number) => number
}

let wasmExports: SimdExports | null = null
let f32View: Float32Array | null = null

function decodeBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'))
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

try {
  const bytes = decodeBase64(SIMD_DISTANCE_WASM_BASE64)
  const wasmBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  if (
    typeof WebAssembly !== 'undefined' &&
    typeof WebAssembly.validate === 'function' &&
    WebAssembly.validate(wasmBuffer)
  ) {
    const module = new WebAssembly.Module(wasmBuffer)
    const instance = new WebAssembly.Instance(module)
    wasmExports = instance.exports as unknown as SimdExports
    f32View = new Float32Array(wasmExports.memory.buffer)
  }
} catch {
  wasmExports = null
  f32View = null
}

const OFFSET_B_BYTES = 16384

function ensureMemory(dim: number): void {
  if (!wasmExports || !f32View) return
  const needed = OFFSET_B_BYTES + dim * 4
  const currentSize = wasmExports.memory.buffer.byteLength
  if (needed > currentSize) {
    const pagesNeeded = Math.ceil(needed / 65536)
    const currentPages = currentSize / 65536
    wasmExports.memory.grow(pagesNeeded - currentPages)
    f32View = new Float32Array(wasmExports.memory.buffer)
  }
}

function getF32View(): Float32Array {
  if (!f32View) {
    throw new Error('SIMD memory is not initialized')
  }
  return f32View
}

function copyOneVector(a: Float32Array): void {
  getF32View().set(a, 0)
}

function copyTwoVectors(a: Float32Array, b: Float32Array): void {
  const view = getF32View()
  view.set(a, 0)
  view.set(b, OFFSET_B_BYTES / 4)
}

export function simdDotProduct(a: Float32Array, b: Float32Array): number | null {
  if (!wasmExports || !f32View) return null
  ensureMemory(a.length)
  copyTwoVectors(a, b)
  return wasmExports.dot_product(0, OFFSET_B_BYTES, a.length)
}

export function simdMagnitude(a: Float32Array): number | null {
  if (!wasmExports || !f32View) return null
  ensureMemory(a.length)
  copyOneVector(a)
  return wasmExports.magnitude(0, a.length)
}

export function simdEuclideanDistance(a: Float32Array, b: Float32Array): number | null {
  if (!wasmExports || !f32View) return null
  ensureMemory(a.length)
  copyTwoVectors(a, b)
  return wasmExports.euclidean_distance(0, OFFSET_B_BYTES, a.length)
}

export function simdSquaredEuclideanDistance(a: Float32Array, b: Float32Array): number | null {
  if (!wasmExports || !f32View) return null
  ensureMemory(a.length)
  copyTwoVectors(a, b)
  return wasmExports.squared_euclidean_distance(0, OFFSET_B_BYTES, a.length)
}

/**
 * Reports whether the runtime loaded the SIMD module that speeds up vector
 * distance work.
 *
 * Vector search works either way, so read this to explain a difference in
 * search latency between two hosts rather than to decide whether to search.
 *
 * @returns True once the SIMD module has loaded.
 *
 * @public
 */
export function isSimdAvailable(): boolean {
  return wasmExports !== null
}

export interface ArenaSimd {
  memory: WebAssembly.Memory
  dot_product: (ptrA: number, ptrB: number, len: number) => number
  magnitude: (ptr: number, len: number) => number
  squared_euclidean_distance: (ptrA: number, ptrB: number, len: number) => number
  dot_u8: (ptrA: number, ptrB: number, len: number) => number
  sqdist_u8: (ptrA: number, ptrB: number, len: number) => number
}

let arenaModule: WebAssembly.Module | null | undefined

function getArenaModule(): WebAssembly.Module | null {
  if (arenaModule !== undefined) return arenaModule
  try {
    const bytes = decodeBase64(SIMD_DISTANCE_WASM_BASE64)
    const wasmBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    if (
      typeof WebAssembly === 'undefined' ||
      typeof WebAssembly.validate !== 'function' ||
      !WebAssembly.validate(wasmBuffer)
    ) {
      arenaModule = null
      return null
    }
    arenaModule = new WebAssembly.Module(wasmBuffer)
  } catch {
    arenaModule = null
  }
  return arenaModule
}

export function createArenaSimd(): ArenaSimd | null {
  try {
    const module = getArenaModule()
    if (module === null) return null
    const instance = new WebAssembly.Instance(module)
    const exports = instance.exports as unknown as ArenaSimd
    if (
      typeof exports.dot_u8 !== 'function' ||
      typeof exports.sqdist_u8 !== 'function' ||
      typeof exports.dot_product !== 'function' ||
      typeof exports.magnitude !== 'function' ||
      typeof exports.squared_euclidean_distance !== 'function' ||
      !(exports.memory instanceof WebAssembly.Memory)
    ) {
      return null
    }
    return exports
  } catch {
    return null
  }
}

let sharedMemoryModule: WebAssembly.Module | null | undefined

function getSharedMemoryModule(): WebAssembly.Module | null {
  if (sharedMemoryModule !== undefined) return sharedMemoryModule
  try {
    const bytes = decodeBase64(SIMD_DISTANCE_SHARED_MEMORY_WASM_BASE64)
    const wasmBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    if (
      typeof WebAssembly === 'undefined' ||
      typeof WebAssembly.validate !== 'function' ||
      !WebAssembly.validate(wasmBuffer)
    ) {
      sharedMemoryModule = null
      return null
    }
    sharedMemoryModule = new WebAssembly.Module(wasmBuffer)
  } catch {
    sharedMemoryModule = null
  }
  return sharedMemoryModule
}

/**
 * Instantiates the distance kernels over a shared memory another thread also
 * reads, so every thread computes against one copy of the vector data.
 *
 * The kernels are compiled from the same source as {@link createArenaSimd}
 * uses, with the module's own memory swapped for the imported one.
 *
 * @param memory A shared WebAssembly memory holding the vector arenas.
 * @returns The kernel exports bound to that memory, or null when the runtime
 * cannot instantiate them.
 *
 * @internal
 */
export function createSharedArenaSimd(memory: WebAssembly.Memory): ArenaSimd | null {
  try {
    const module = getSharedMemoryModule()
    if (module === null) return null
    const instance = new WebAssembly.Instance(module, { env: { memory } })
    const exports = instance.exports as unknown as Omit<ArenaSimd, 'memory'>
    if (
      typeof exports.dot_u8 !== 'function' ||
      typeof exports.sqdist_u8 !== 'function' ||
      typeof exports.dot_product !== 'function' ||
      typeof exports.magnitude !== 'function' ||
      typeof exports.squared_euclidean_distance !== 'function'
    ) {
      return null
    }
    return {
      memory,
      dot_product: exports.dot_product,
      magnitude: exports.magnitude,
      squared_euclidean_distance: exports.squared_euclidean_distance,
      dot_u8: exports.dot_u8,
      sqdist_u8: exports.sqdist_u8,
    }
  } catch {
    return null
  }
}

/**
 * Computes the distance between two float32 vectors already resident in a
 * kernel's memory, given their byte offsets and magnitudes.
 *
 * The main thread's private store and a worker's shared view both answer
 * arena distances through this one function, so the two paths cannot drift.
 *
 * @param simd The kernel instance whose memory holds both vectors.
 * @param byteA The first vector's byte offset.
 * @param byteB The second vector's byte offset.
 * @param dimension The number of components in each vector.
 * @param metric The distance metric to compute.
 * @param magnitudeA The first vector's magnitude, used by cosine alone.
 * @param magnitudeB The second vector's magnitude, used by cosine alone.
 * @returns The distance under the metric.
 *
 * @internal
 */
export function arenaFloat32Distance(
  simd: ArenaSimd,
  byteA: number,
  byteB: number,
  dimension: number,
  metric: VectorMetric,
  magnitudeA: number,
  magnitudeB: number,
): number {
  if (metric === 'euclidean') {
    return Math.sqrt(simd.squared_euclidean_distance(byteA, byteB, dimension))
  }
  const dot = simd.dot_product(byteA, byteB, dimension)
  if (metric === 'dotProduct') return -dot
  if (magnitudeA === 0 || magnitudeB === 0) return 1
  return 1 - dot / (magnitudeA * magnitudeB)
}
