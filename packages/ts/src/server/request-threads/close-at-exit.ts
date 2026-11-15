const CLOSE_WORD = 0
const CLOSED_WORD = 1
const OPEN = 0
const SIGNALLED = 1

export function createCloseAtExitWords(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT))
}

export function threadCloseRequested(word: Int32Array<SharedArrayBuffer>): boolean {
  return Atomics.load(word, CLOSE_WORD) === SIGNALLED
}

export function threadCloseAcknowledged(word: Int32Array<SharedArrayBuffer>): boolean {
  return Atomics.load(word, CLOSED_WORD) === SIGNALLED
}

export async function threadCloseAcknowledgedWithin(
  word: Int32Array<SharedArrayBuffer>,
  timeoutMs: number,
): Promise<void> {
  const waiting = Atomics.waitAsync(word, CLOSED_WORD, OPEN, timeoutMs)
  if (waiting.async) await waiting.value
}

export function acknowledgeThreadClose(word: Int32Array<SharedArrayBuffer>): void {
  Atomics.store(word, CLOSE_WORD, SIGNALLED)
  Atomics.notify(word, CLOSE_WORD)
  Atomics.store(word, CLOSED_WORD, SIGNALLED)
  Atomics.notify(word, CLOSED_WORD)
}

export function closeEveryThreadAtExit(words: Iterable<Int32Array>, timeoutMs: number): void {
  const signalled = [...words]
  for (const word of signalled) {
    Atomics.store(word, CLOSE_WORD, SIGNALLED)
    Atomics.notify(word, CLOSE_WORD)
  }
  const deadline = Date.now() + timeoutMs
  for (const word of signalled) {
    let left = deadline - Date.now()
    while (Atomics.load(word, CLOSED_WORD) !== SIGNALLED && left > 0) {
      Atomics.wait(word, CLOSED_WORD, OPEN, left)
      left = deadline - Date.now()
    }
  }
}

export async function closeWhenTheProcessExits(word: Int32Array<SharedArrayBuffer>, close: () => void): Promise<void> {
  const waiting = Atomics.waitAsync(word, CLOSE_WORD, OPEN)
  if (waiting.async) await waiting.value
  try {
    close()
  } finally {
    acknowledgeThreadClose(word)
  }
}
