const SIMD_PROBE_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
])

function runtimeStartsSimdModule(): boolean {
  try {
    if (typeof WebAssembly === 'undefined') return false
    new WebAssembly.Instance(new WebAssembly.Module(SIMD_PROBE_MODULE))
    return true
  } catch {
    return false
  }
}

let simdAvailable = runtimeStartsSimdModule()

/**
 * Reports whether the runtime can run the SIMD module that speeds up vector
 * distance work.
 *
 * Vector search works either way, so read this to explain a difference in
 * search latency between two hosts rather than to decide whether to search.
 *
 * @returns True when the runtime can compile and start a WebAssembly module
 * that uses SIMD instructions, and false once the vector code fails to load its
 * own SIMD module.
 *
 * @public
 */
export function isSimdAvailable(): boolean {
  return simdAvailable
}

export function markSimdUnavailable(): void {
  simdAvailable = false
}
