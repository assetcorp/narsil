const DEPARTURE_WORD = 0
const AWAITING_DEPARTURE = 0
const DEPARTURE_CONFIRMED = 1

export function createDepartureWord(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
}

export function confirmDeparture(word: Int32Array): void {
  Atomics.store(word, DEPARTURE_WORD, DEPARTURE_CONFIRMED)
  Atomics.notify(word, DEPARTURE_WORD)
}

export function departureConfirmed(word: Int32Array): boolean {
  return Atomics.load(word, DEPARTURE_WORD) === DEPARTURE_CONFIRMED
}

export function awaitDepartureConfirmation(word: Int32Array): void {
  while (!departureConfirmed(word)) Atomics.wait(word, DEPARTURE_WORD, AWAITING_DEPARTURE)
}

export async function departureConfirmation(word: Int32Array<SharedArrayBuffer>): Promise<void> {
  const waiting = Atomics.waitAsync(word, DEPARTURE_WORD, AWAITING_DEPARTURE)
  if (waiting.async) await waiting.value
}
