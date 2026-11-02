type TypedArrayConstructor = new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView

const ERROR_CONSTRUCTORS: Record<string, ErrorConstructor> = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
}

function dataCloneError(message: string): Error {
  const DomException = (globalThis as { DOMException?: new (message: string, name: string) => Error }).DOMException
  if (DomException !== undefined) return new DomException(message, 'DataCloneError')
  const error = new Error(message)
  error.name = 'DataCloneError'
  return error
}

function typedArrayConstructorOf(view: ArrayBufferView): TypedArrayConstructor | null {
  const viewType = (view as { constructor?: unknown }).constructor
  if (typeof viewType !== 'function') return null
  const scope = globalThis as Record<string, unknown>
  const name = (viewType as { name?: unknown }).name
  if (typeof name !== 'string' || scope[name] !== viewType) return null
  return viewType as TypedArrayConstructor
}

function cloneValue(value: unknown, memory: Map<object, unknown>): unknown {
  if (typeof value === 'symbol') throw dataCloneError('A symbol cannot be cloned')
  if (typeof value === 'function') throw dataCloneError('A function cannot be cloned')
  if (value === null || typeof value !== 'object') return value

  const remembered = memory.get(value)
  if (remembered !== undefined || memory.has(value)) return remembered

  if (value instanceof Date) {
    const copy = new Date(value.getTime())
    memory.set(value, copy)
    return copy
  }
  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags)
    memory.set(value, copy)
    return copy
  }
  if (value instanceof Boolean || value instanceof Number || value instanceof String) {
    const copy = Object(value.valueOf())
    memory.set(value, copy)
    return copy
  }
  if (typeof BigInt !== 'undefined' && Object.prototype.toString.call(value) === '[object BigInt]') {
    const copy = Object((value as { valueOf(): bigint }).valueOf())
    memory.set(value, copy)
    return copy
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0, value.byteLength)
    memory.set(value, copy)
    return copy
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = cloneValue(value.buffer, memory) as ArrayBuffer
    if (value instanceof DataView) {
      const copy = new DataView(buffer, value.byteOffset, value.byteLength)
      memory.set(value, copy)
      return copy
    }
    const ViewType = typedArrayConstructorOf(value)
    if (ViewType === null) throw dataCloneError('This kind of array buffer view cannot be cloned')
    const length = (value as unknown as { length: number }).length
    const copy = new ViewType(buffer, value.byteOffset, length)
    memory.set(value, copy)
    return copy
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>()
    memory.set(value, copy)
    for (const [key, entry] of value) copy.set(cloneValue(key, memory), cloneValue(entry, memory))
    return copy
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>()
    memory.set(value, copy)
    for (const entry of value) copy.add(cloneValue(entry, memory))
    return copy
  }
  if (value instanceof Error) {
    const ErrorType = ERROR_CONSTRUCTORS[value.name] ?? Error
    const copy = new ErrorType(value.message)
    memory.set(value, copy)
    if (typeof value.stack === 'string') copy.stack = value.stack
    if ('cause' in value) (copy as { cause?: unknown }).cause = cloneValue(value.cause, memory)
    return copy
  }

  const copy = (Array.isArray(value) ? new Array<unknown>(value.length) : {}) as Record<string, unknown>
  memory.set(value, copy)
  for (const key of Object.keys(value)) {
    copy[key] = cloneValue((value as Record<string, unknown>)[key], memory)
  }
  return copy
}

function structuredCloneStandIn<T>(value: T): T {
  return cloneValue(value, new Map()) as T
}

export function installStructuredClone(): void {
  if (typeof (globalThis as { structuredClone?: unknown }).structuredClone === 'function') return
  Object.defineProperty(globalThis, 'structuredClone', {
    value: structuredCloneStandIn,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}
