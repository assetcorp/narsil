const STATE_WORD = 0
const OPEN = 0n

export function createServerCloseSignal(): BigInt64Array<SharedArrayBuffer> {
  return new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT))
}

export function signalServerClose(signal: BigInt64Array<SharedArrayBuffer>, deadlineMs: number): number {
  Atomics.compareExchange(signal, STATE_WORD, OPEN, BigInt(Date.now() + deadlineMs))
  return Number(Atomics.load(signal, STATE_WORD))
}

export function serverCloseDeadline(signal: BigInt64Array<SharedArrayBuffer>): number | null {
  const deadline = Atomics.load(signal, STATE_WORD)
  return deadline === OPEN ? null : Number(deadline)
}

export function serverCloseSignalled(signal: BigInt64Array<SharedArrayBuffer>): boolean {
  return serverCloseDeadline(signal) !== null
}
