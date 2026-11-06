import type { NativeKeywordCore } from '@delali/narsil'
import type { NarsilCore } from '../specs/core.nitro'
import { withNativeCode } from './native-error'

export function adaptKeyword(core: NarsilCore): NativeKeywordCore {
  const method: unknown = Reflect.get(core, 'keywordScore')
  if (typeof method !== 'function') {
    return {
      keywordScore() {
        throw new Error('The native search core on this phone has no keywordScore method, so it cannot score text.')
      },
    }
  }
  return {
    keywordScore(...parameters) {
      let status: unknown
      try {
        status = Reflect.apply(method, core, parameters)
      } catch (error) {
        throw withNativeCode(error)
      }
      if (typeof status !== 'number') throw new Error('The native search core returned no status from keywordScore.')
      return status
    },
  }
}
