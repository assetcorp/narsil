type IntegerArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array

type Element = number | bigint

type WaitResult = 'ok' | 'not-equal' | 'timed-out'

interface Waiter {
  settle(result: WaitResult): void
}

const INTEGER_ARRAY_TYPES: ReadonlyArray<abstract new (...args: never[]) => IntegerArray> = [
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
]

const WAITABLE_ARRAY_TYPES: ReadonlyArray<abstract new (...args: never[]) => IntegerArray> = [Int32Array, BigInt64Array]

const waitersByBuffer = new WeakMap<ArrayBufferLike, Map<number, Waiter[]>>()

export interface NativeAtomics {
  ownsMemory(buffer: ArrayBuffer): boolean
  atomic(
    operation: number,
    elementKind: number,
    buffer: ArrayBuffer,
    byteIndex: number,
    value: number,
    replacement: number,
  ): number
}

const NATIVE_LOAD = 0
const NATIVE_STORE = 1
const NATIVE_ADD = 2
const NATIVE_SUB = 3
const NATIVE_AND = 4
const NATIVE_OR = 5
const NATIVE_XOR = 6
const NATIVE_EXCHANGE = 7
const NATIVE_COMPARE_EXCHANGE = 8

let nativeAtomics: NativeAtomics | null = null
const nativeOwnership = new WeakMap<ArrayBufferLike, boolean>()

function nativeElementKind(array: IntegerArray): number {
  if (array instanceof Int8Array) return 0
  if (array instanceof Uint8Array) return 1
  if (array instanceof Int16Array) return 2
  if (array instanceof Uint16Array) return 3
  if (array instanceof Int32Array) return 4
  if (array instanceof Uint32Array) return 5
  return -1
}

function onNativeMemory(array: IntegerArray): number {
  if (nativeAtomics === null) return -1
  const kind = nativeElementKind(array)
  if (kind < 0) return -1
  let owned = nativeOwnership.get(array.buffer)
  if (owned === undefined) {
    owned = nativeAtomics.ownsMemory(array.buffer as ArrayBuffer)
    nativeOwnership.set(array.buffer, owned)
  }
  return owned ? kind : -1
}

function nativeAtomic(
  atomics: NativeAtomics,
  operation: number,
  kind: number,
  array: IntegerArray,
  position: number,
  value: unknown,
  replacement: unknown,
): number {
  const byteIndex = array.byteOffset + position * array.BYTES_PER_ELEMENT
  return atomics.atomic(operation, kind, array.buffer as ArrayBuffer, byteIndex, Number(value), Number(replacement))
}

function isOneOf(array: unknown, types: ReadonlyArray<abstract new (...args: never[]) => IntegerArray>): boolean {
  for (const type of types) {
    if (array instanceof type) return true
  }
  return false
}

function requireIndex(array: IntegerArray, index: unknown): number {
  const position = Number(index)
  if (!Number.isInteger(position) || position < 0 || position >= array.length) {
    throw new RangeError(`Atomics index ${String(index)} lies outside the array of ${array.length} elements`)
  }
  return position
}

function requireIntegerArray(array: unknown): IntegerArray {
  if (!isOneOf(array, INTEGER_ARRAY_TYPES)) throw new TypeError('Atomics needs an integer typed array')
  return array as IntegerArray
}

function asElement(array: IntegerArray, value: unknown): Element {
  if (array instanceof BigInt64Array || array instanceof BigUint64Array) return BigInt(value as bigint)
  return Number(value)
}

function readModifyWrite(
  array: unknown,
  index: unknown,
  value: unknown,
  operation: number,
  combine: (previous: Element, operand: Element) => Element,
): Element {
  const target = requireIntegerArray(array)
  const position = requireIndex(target, index)
  const kind = onNativeMemory(target)
  if (kind >= 0 && nativeAtomics !== null) {
    return nativeAtomic(nativeAtomics, operation, kind, target, position, value, 0)
  }
  const previous = target[position] as Element
  ;(target as unknown as Element[])[position] = combine(previous, asElement(target, value))
  return previous
}

function sameAsStored(array: IntegerArray, stored: Element, value: unknown): boolean {
  const scratch = new (array.constructor as new (length: number) => IntegerArray)(1)
  ;(scratch as unknown as Element[])[0] = asElement(array, value)
  return scratch[0] === stored
}

function waitersAt(array: IntegerArray, position: number): Waiter[] {
  let byIndex = waitersByBuffer.get(array.buffer)
  if (byIndex === undefined) {
    byIndex = new Map()
    waitersByBuffer.set(array.buffer, byIndex)
  }
  const byteIndex = array.byteOffset + position * array.BYTES_PER_ELEMENT
  let waiters = byIndex.get(byteIndex)
  if (waiters === undefined) {
    waiters = []
    byIndex.set(byteIndex, waiters)
  }
  return waiters
}

function forgetWaiters(array: IntegerArray, position: number, waiters: Waiter[]): void {
  if (waiters.length > 0) return
  const byIndex = waitersByBuffer.get(array.buffer)
  if (byIndex === undefined) return
  byIndex.delete(array.byteOffset + position * array.BYTES_PER_ELEMENT)
  if (byIndex.size === 0) waitersByBuffer.delete(array.buffer)
}

function requireWaitable(array: unknown, index: unknown): { target: IntegerArray; position: number } {
  if (!isOneOf(array, WAITABLE_ARRAY_TYPES))
    throw new TypeError('Atomics waits only on an Int32Array or a BigInt64Array')
  const target = array as IntegerArray
  return { target, position: requireIndex(target, index) }
}

function waitAsync(
  array: unknown,
  index: unknown,
  value: unknown,
  timeout?: number,
): { async: false; value: WaitResult } | { async: true; value: Promise<WaitResult> } {
  const { target, position } = requireWaitable(array, index)
  if (!sameAsStored(target, target[position] as Element, value)) return { async: false, value: 'not-equal' }
  const limit = timeout === undefined || Number.isNaN(Number(timeout)) ? Infinity : Math.max(0, Number(timeout))
  if (limit === 0) return { async: false, value: 'timed-out' }
  const waiters = waitersAt(target, position)
  const settled = new Promise<WaitResult>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const waiter: Waiter = {
      settle(result) {
        if (timer !== undefined) clearTimeout(timer)
        resolve(result)
      },
    }
    waiters.push(waiter)
    if (Number.isFinite(limit)) {
      timer = setTimeout(() => {
        const at = waiters.indexOf(waiter)
        if (at !== -1) waiters.splice(at, 1)
        forgetWaiters(target, position, waiters)
        resolve('timed-out')
      }, limit)
    }
  })
  return { async: true, value: settled }
}

function notify(array: unknown, index: unknown, count?: number): number {
  const target = requireIntegerArray(array)
  const position = requireIndex(target, index)
  if (!isOneOf(target, WAITABLE_ARRAY_TYPES)) return 0
  const byIndex = waitersByBuffer.get(target.buffer)
  const waiters = byIndex?.get(target.byteOffset + position * target.BYTES_PER_ELEMENT)
  if (waiters === undefined) return 0
  const wanted = count === undefined ? waiters.length : Math.max(0, Math.floor(Number(count)))
  const woken = waiters.splice(0, wanted)
  forgetWaiters(target, position, waiters)
  for (const waiter of woken) waiter.settle('ok')
  return woken.length
}

function wait(array: unknown, index: unknown, value: unknown): WaitResult {
  const { target, position } = requireWaitable(array, index)
  if (!sameAsStored(target, target[position] as Element, value)) return 'not-equal'
  throw new TypeError('Atomics.wait would block the only thread of this runtime, so it cannot wait here')
}

const standInAtomics = {
  add: (array: unknown, index: unknown, value: unknown) =>
    readModifyWrite(array, index, value, NATIVE_ADD, (a, b) => (a as number) + (b as number)),
  sub: (array: unknown, index: unknown, value: unknown) =>
    readModifyWrite(array, index, value, NATIVE_SUB, (a, b) => (a as number) - (b as number)),
  and: (array: unknown, index: unknown, value: unknown) =>
    readModifyWrite(array, index, value, NATIVE_AND, (a, b) => (a as number) & (b as number)),
  or: (array: unknown, index: unknown, value: unknown) =>
    readModifyWrite(array, index, value, NATIVE_OR, (a, b) => (a as number) | (b as number)),
  xor: (array: unknown, index: unknown, value: unknown) =>
    readModifyWrite(array, index, value, NATIVE_XOR, (a, b) => (a as number) ^ (b as number)),
  exchange: (array: unknown, index: unknown, value: unknown) =>
    readModifyWrite(array, index, value, NATIVE_EXCHANGE, (_a, b) => b),
  compareExchange(array: unknown, index: unknown, expected: unknown, replacement: unknown): Element {
    const target = requireIntegerArray(array)
    const position = requireIndex(target, index)
    const kind = onNativeMemory(target)
    if (kind >= 0 && nativeAtomics !== null) {
      return nativeAtomic(nativeAtomics, NATIVE_COMPARE_EXCHANGE, kind, target, position, expected, replacement)
    }
    const previous = target[position] as Element
    if (sameAsStored(target, previous, expected)) {
      ;(target as unknown as Element[])[position] = asElement(target, replacement)
    }
    return previous
  },
  load(array: unknown, index: unknown): Element {
    const target = requireIntegerArray(array)
    const position = requireIndex(target, index)
    const kind = onNativeMemory(target)
    if (kind >= 0 && nativeAtomics !== null) {
      return nativeAtomic(nativeAtomics, NATIVE_LOAD, kind, target, position, 0, 0)
    }
    return target[position] as Element
  },
  store(array: unknown, index: unknown, value: unknown): Element {
    const target = requireIntegerArray(array)
    const position = requireIndex(target, index)
    const kind = onNativeMemory(target)
    if (kind >= 0 && nativeAtomics !== null) {
      nativeAtomic(nativeAtomics, NATIVE_STORE, kind, target, position, value, 0)
      return Math.trunc(Number(value))
    }
    const element = asElement(target, value)
    ;(target as unknown as Element[])[position] = element
    return typeof element === 'bigint' ? element : Math.trunc(element)
  },
  isLockFree: (size: number) => size === 1 || size === 2 || size === 4 || size === 8,
  wait,
  waitAsync,
  notify,
  pause: () => {},
}

export function installAtomics(native: NativeAtomics): void {
  if (typeof (globalThis as { Atomics?: unknown }).Atomics === 'object') return
  nativeAtomics = native
  Object.defineProperty(globalThis, 'Atomics', {
    value: standInAtomics,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}
