export function afterCurrentTurn(callback: () => void): void {
  if (typeof setImmediate === 'function') {
    setImmediate(callback)
    return
  }
  setTimeout(callback, 0)
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => afterCurrentTurn(resolve))
}
