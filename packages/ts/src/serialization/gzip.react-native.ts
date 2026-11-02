import { reactNativeHost } from '../runtime/react-native-host'

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return reactNativeHost().gzip(data)
}

export async function gunzip(compressed: Uint8Array, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  return reactNativeHost().gunzip(compressed, Math.min(maxBytes, Number.MAX_SAFE_INTEGER))
}
