import { SIMD_DISTANCE_WASM_BASE64 } from './simd-wasm-binary'

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

export function isSimdAvailable(): boolean {
  return wasmExports !== null
}
