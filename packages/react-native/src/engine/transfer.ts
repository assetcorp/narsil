import type { TransferredError } from '../transferred'

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function viewCopy(view: ArrayBufferView): ArrayBufferView {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view
  const copy = new Uint8Array(view.byteLength)
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  if (view instanceof DataView) return new DataView(copy.buffer)
  const Constructor = view.constructor as new (buffer: ArrayBuffer) => ArrayBufferView
  return new Constructor(copy.buffer)
}

export function transferredError(error: unknown, seen = new Map<object, unknown>()): TransferredError {
  if (!(error instanceof Error)) {
    return { transferredError: true, name: 'Error', message: String(error), code: undefined, details: undefined }
  }
  const coded = error as Error & { code?: unknown; details?: unknown }
  return {
    transferredError: true,
    name: error.name,
    message: error.message,
    code: typeof coded.code === 'string' ? coded.code : undefined,
    details: coded.details === undefined ? undefined : transferable(coded.details, seen),
  }
}

export function transferable(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value
  const known = seen.get(value)
  if (known !== undefined) return known
  if (ArrayBuffer.isView(value)) {
    const copy = viewCopy(value)
    seen.set(value, copy)
    return copy
  }
  if (value instanceof Error) {
    const copy = transferredError(value, seen)
    seen.set(value, copy)
    return copy
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length)
    seen.set(value, copy)
    for (let index = 0; index < value.length; index++) copy[index] = transferable(value[index], seen)
    return copy
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>()
    seen.set(value, copy)
    for (const [key, entry] of value) copy.set(transferable(key, seen), transferable(entry, seen))
    return copy
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>()
    seen.set(value, copy)
    for (const entry of value) copy.add(transferable(entry, seen))
    return copy
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer) return value
  if (!isPlainObject(value)) return value
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    const entry = transferable((value as Record<string, unknown>)[key], seen)
    if (entry !== undefined) copy[key] = entry
  }
  return copy
}
