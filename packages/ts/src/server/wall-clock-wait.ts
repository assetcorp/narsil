export interface WallClockWait {
  readonly reached: Promise<void>
  cancel(): void
}

export function waitUntilWallClock(deadline: number): WallClockWait {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const reached = new Promise<void>(resolve => {
    const check = (): void => {
      if (cancelled) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        resolve()
        return
      }
      timer = setTimeout(check, remaining)
    }
    check()
  })
  return {
    reached,
    cancel() {
      cancelled = true
      clearTimeout(timer)
    },
  }
}
