import { useEffect, useEffectEvent } from 'react'

const watchers = new Set<() => void>()
let listening = false

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function announce(): void {
  for (const watcher of [...watchers]) watcher()
}

/** Every polling hook shares one `visibilitychange` listener, so a page holding
 * a hundred of them still registers one. */
function watchVisibility(watcher: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined
  watchers.add(watcher)
  if (!listening) {
    listening = true
    document.addEventListener('visibilitychange', announce)
  }
  return () => {
    watchers.delete(watcher)
    if (watchers.size > 0) return
    listening = false
    document.removeEventListener('visibilitychange', announce)
  }
}

/**
 * Runs an action on a timer while a condition holds, and pauses it while the
 * page is hidden, so that a background tab stops asking a server for figures
 * nobody is reading. The action runs once as soon as the page comes back.
 *
 * @param action - This runs on each tick, and the newest one always runs
 * without restarting the timer.
 * @param intervalMs - The action runs this often, and anything at or below zero
 * turns the timer off.
 * @param active - The timer runs only while this is true.
 */
export function usePolling(action: () => void, intervalMs: number, active: boolean): void {
  const run = useEffectEvent(action)

  useEffect(() => {
    if (!active || intervalMs <= 0) return
    let timer: ReturnType<typeof setTimeout> | undefined

    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const tick = (): void => {
      run()
      timer = setTimeout(tick, intervalMs)
    }
    const start = (): void => {
      stop()
      timer = setTimeout(tick, intervalMs)
    }
    const onVisibilityChange = (): void => {
      if (isHidden()) {
        stop()
        return
      }
      run()
      start()
    }

    if (!isHidden()) start()
    const unwatch = watchVisibility(onVisibilityChange)

    return () => {
      stop()
      unwatch()
    }
  }, [active, intervalMs])
}
