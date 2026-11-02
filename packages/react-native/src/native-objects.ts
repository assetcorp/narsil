import type { BoxedHybridObject } from 'react-native-nitro-modules'
import { nativeDependencyMissing } from './errors'
import type { NarsilCore } from './specs/core.nitro'
import type { NarsilFiles } from './specs/files.nitro'
import type { NarsilHost } from './specs/host.nitro'

export interface BoxedNativeObjects {
  host: BoxedHybridObject<NarsilHost>
  files: BoxedHybridObject<NarsilFiles>
  core: BoxedHybridObject<NarsilCore>
}

let loading: Promise<BoxedNativeObjects> | null = null

async function boxNativeObjects(): Promise<BoxedNativeObjects> {
  try {
    const { NitroModules } = await import('react-native-nitro-modules')
    return {
      host: NitroModules.box(NitroModules.createHybridObject<NarsilHost>('NarsilHost')),
      files: NitroModules.box(NitroModules.createHybridObject<NarsilFiles>('NarsilFiles')),
      core: NitroModules.box(NitroModules.createHybridObject<NarsilCore>('NarsilCore')),
    }
  } catch (error) {
    throw nativeDependencyMissing(error)
  }
}

export function loadNativeObjects(): Promise<BoxedNativeObjects> {
  if (loading === null) {
    loading = boxNativeObjects()
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}
