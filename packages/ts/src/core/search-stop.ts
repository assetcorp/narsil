const signals = new WeakMap<object, AbortSignal>()
const flags = new WeakMap<AbortSignal, Uint32Array>()
const noStop = new Uint32Array(1)

export function bindSearchSignal(search: object, signal: AbortSignal | undefined): void {
  if (signal !== undefined) signals.set(search, signal)
}

export function signalOfSearch(search: object | undefined): AbortSignal | undefined {
  return search === undefined ? undefined : signals.get(search)
}

export function bindSignalStop(signal: AbortSignal, stop: Uint32Array): void {
  flags.set(signal, stop)
  const abort = (): void => {
    Atomics.store(stop, 0, 1)
  }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
}

export function stopOfSignal(signal: AbortSignal | undefined): Uint32Array {
  if (signal === undefined) return noStop
  let stop = flags.get(signal)
  if (stop !== undefined) return stop
  stop = new Uint32Array(typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : new ArrayBuffer(4))
  bindSignalStop(signal, stop)
  return stop
}

export function sharedStopOfSignal(signal: AbortSignal | undefined): SharedArrayBuffer | undefined {
  if (signal === undefined || typeof SharedArrayBuffer !== 'function') return undefined
  const buffer = stopOfSignal(signal).buffer
  return buffer instanceof SharedArrayBuffer ? buffer : undefined
}

export function requireSearchActive(stop: Uint32Array | undefined, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (stop !== undefined && Atomics.load(stop, 0) !== 0) throw new DOMException('The search was aborted', 'AbortError')
}
