import { reactNativeHost } from './react-native-host'

export function collectAndReturnPages(): boolean {
  try {
    return reactNativeHost().collectGarbage()
  } catch {
    return false
  }
}

export function collectYoungGeneration(): boolean {
  return false
}

export function startIdleHeapCleanup(): () => void {
  return () => undefined
}
