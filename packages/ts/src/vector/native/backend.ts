export type NativeOperation = 'search' | 'score' | 'place' | 'remove' | 'compact' | 'calibrate' | 'quantise'

let nativeSearchCoreEnabled = true
let fallbackObserver: ((operation: NativeOperation) => void) | null = null

export function setNativeSearchCoreEnabled(enabled: boolean): void {
  nativeSearchCoreEnabled = enabled
}

export function nativeSearchCoreIsEnabled(): boolean {
  return nativeSearchCoreEnabled
}

export function stopUsingTheNativeSearchCore(error: unknown): void {
  if (!nativeSearchCoreEnabled) return
  nativeSearchCoreEnabled = false
  console.warn(
    'The native search core raised an error, so this thread searches through WebAssembly from now on:',
    error instanceof Error ? error.message : String(error),
  )
}

export function observeFallbacks(observer: ((operation: NativeOperation) => void) | null): void {
  fallbackObserver = observer
}

export function noteFallback(operation: NativeOperation): void {
  if (fallbackObserver !== null) fallbackObserver(operation)
}
