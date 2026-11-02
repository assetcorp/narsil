import type { NativeObjects } from './engine/host'
import { nativeDependencyMissing } from './errors'
import type { NarsilCore } from './specs/core.nitro'
import type { NarsilFiles } from './specs/files.nitro'
import type { NarsilHost } from './specs/host.nitro'

let loading: Promise<NativeObjects> | null = null

async function createNativeObjects(): Promise<NativeObjects> {
  try {
    const { NitroModules } = await import('react-native-nitro-modules')
    return {
      host: NitroModules.createHybridObject<NarsilHost>('NarsilHost'),
      files: NitroModules.createHybridObject<NarsilFiles>('NarsilFiles'),
      core: NitroModules.createHybridObject<NarsilCore>('NarsilCore'),
    }
  } catch (error) {
    throw nativeDependencyMissing(error)
  }
}

export function loadNativeObjects(): Promise<NativeObjects> {
  if (loading === null) {
    loading = createNativeObjects()
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}
