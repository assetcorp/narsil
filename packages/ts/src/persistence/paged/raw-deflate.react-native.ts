import { reactNativeHost } from '../../runtime/react-native-host'

export function deflateBlock(raw: Uint8Array): Uint8Array {
  return reactNativeHost().deflateRaw(raw)
}

export function inflateBlock(compressed: Uint8Array, rawLength: number): Uint8Array {
  return reactNativeHost().inflateRaw(compressed, rawLength)
}
