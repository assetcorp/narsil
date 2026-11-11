export interface Serial {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function createSerial(): Serial {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task)
      tail = result.catch(() => undefined)
      return result
    },
  }
}
