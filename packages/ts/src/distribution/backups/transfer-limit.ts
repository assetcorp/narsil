export type TransferLimit = <T>(transfer: () => Promise<T>) => Promise<T>

export function createTransferLimit(transfersAtOnce: number): TransferLimit {
  let running = 0
  const waiting: Array<() => void> = []

  function release(): void {
    const next = waiting.shift()
    if (next === undefined) running -= 1
    else next()
  }

  return async transfer => {
    if (running < transfersAtOnce) running += 1
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      return await transfer()
    } finally {
      release()
    }
  }
}
