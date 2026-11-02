import { createPosixPath } from '../../runtime/posix-path'
import { reactNativeHost } from '../../runtime/react-native-host'
import type { FsModule, PathModule } from './node-fs'
import { createPhoneFs } from './phone-fs'

export type { FsModule, PathModule } from './node-fs'

let cachedFs: FsModule | null = null
let cachedPath: PathModule | null = null

export async function getPath(): Promise<PathModule> {
  if (cachedPath === null) {
    const host = reactNativeHost()
    cachedPath = createPosixPath(() => host.appStorageDirectory()) as unknown as PathModule
  }
  return cachedPath
}

export async function getFs(): Promise<FsModule> {
  if (cachedFs === null) {
    const path = await getPath()
    cachedFs = createPhoneFs(reactNativeHost().files, path.dirname) as unknown as FsModule
  }
  return cachedFs
}
