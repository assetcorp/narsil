import type { NarsilHost } from '../../specs/host.nitro'

const MAX_RANDOM_BYTES_PER_CALL = 65_536
const UUID_BYTES = 16
const UUID_VERSION_BYTE = 6
const UUID_VARIANT_BYTE = 8
const UUID_HYPHEN_AFTER_BYTES = new Set([4, 6, 8, 10])

interface CryptoLike {
  getRandomValues?: unknown
  randomUUID?: unknown
}

function isIntegerArray(view: ArrayBufferView): boolean {
  return (
    view instanceof Int8Array ||
    view instanceof Uint8Array ||
    view instanceof Uint8ClampedArray ||
    view instanceof Int16Array ||
    view instanceof Uint16Array ||
    view instanceof Int32Array ||
    view instanceof Uint32Array ||
    view instanceof BigInt64Array ||
    view instanceof BigUint64Array
  )
}

function namedError(message: string, name: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export function installCrypto(host: NarsilHost): void {
  const scope = globalThis as { crypto?: CryptoLike }
  const existing = scope.crypto
  if (typeof existing?.getRandomValues === 'function' && typeof existing.randomUUID === 'function') return

  function getRandomValues<T extends ArrayBufferView>(array: T): T {
    if (!ArrayBuffer.isView(array) || !isIntegerArray(array)) {
      throw namedError('getRandomValues fills only an integer typed array', 'TypeMismatchError')
    }
    if (array.byteLength > MAX_RANDOM_BYTES_PER_CALL) {
      throw namedError(
        `getRandomValues fills at most ${MAX_RANDOM_BYTES_PER_CALL} bytes per call, not ${array.byteLength}`,
        'QuotaExceededError',
      )
    }
    host.fillRandom(array.buffer as ArrayBuffer, array.byteOffset, array.byteLength)
    return array
  }

  function randomUUID(): string {
    const bytes = new Uint8Array(UUID_BYTES)
    host.fillRandom(bytes.buffer, 0, UUID_BYTES)
    bytes[UUID_VERSION_BYTE] = ((bytes[UUID_VERSION_BYTE] ?? 0) & 0x0f) | 0x40
    bytes[UUID_VARIANT_BYTE] = ((bytes[UUID_VARIANT_BYTE] ?? 0) & 0x3f) | 0x80
    let text = ''
    for (let index = 0; index < UUID_BYTES; index++) {
      if (UUID_HYPHEN_AFTER_BYTES.has(index)) text += '-'
      text += (bytes[index] ?? 0).toString(16).padStart(2, '0')
    }
    return text
  }

  const crypto: CryptoLike = existing ?? {}
  if (typeof crypto.getRandomValues !== 'function') {
    Object.defineProperty(crypto, 'getRandomValues', { value: getRandomValues, writable: true, configurable: true })
  }
  if (typeof crypto.randomUUID !== 'function') {
    Object.defineProperty(crypto, 'randomUUID', { value: randomUUID, writable: true, configurable: true })
  }
  if (existing === undefined) {
    Object.defineProperty(globalThis, 'crypto', {
      value: crypto,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
}
