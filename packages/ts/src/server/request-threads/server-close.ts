const STATE_WORD = 0
const CLOSING = 1

export function createServerCloseSignal(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
}

export function signalServerClose(signal: Int32Array<SharedArrayBuffer>): void {
  Atomics.store(signal, STATE_WORD, CLOSING)
}

export function serverCloseSignalled(signal: Int32Array<SharedArrayBuffer>): boolean {
  return Atomics.load(signal, STATE_WORD) === CLOSING
}
