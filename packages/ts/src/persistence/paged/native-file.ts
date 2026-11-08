import { loadNativeCore } from '#platform/native-core'
import { ErrorCodes, NarsilError } from '../../errors'
import { HEADER_SIZE } from '../../serialization/header'
import { nativeSearchCoreIsEnabled } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import type { NativePagedFileHandle, NativePageSection } from '../../vector/native/types/paged'
import type { FileSection } from './format'

const PAGE_CORRUPT = -9

export interface NativeOpenFile {
  readonly core: NativeCore
  readonly handle: NativePagedFileHandle
}

export function requireNativePage(status: number, path: string, section: string, page: bigint): void {
  if (status === 0) return
  failNativePage(status, path, section, page)
}

export function failNativePage(status: number, path: string, section: string, page: bigint): never {
  const code = status === PAGE_CORRUPT ? ErrorCodes.PERSISTENCE_CRC_MISMATCH : ErrorCodes.PERSISTENCE_LOAD_FAILED
  throw new NarsilError(code, `The core cannot read page ${page} of section "${section}" of "${path}"`, {
    path,
    section,
    page: Number(page),
    status,
  })
}

export function openNativePagedFile(path: string): NativeOpenFile | null {
  const core = nativeSearchCoreIsEnabled() ? loadNativeCore() : null
  if (core === null) return null
  const handle = core.openPagedFile(path)
  if (typeof handle === 'number') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The core cannot open "${path}" for reading`, {
      path,
      status: handle,
    })
  }
  return { core, handle }
}

export function nativeSection(file: NativeOpenFile | null, section: FileSection): NativePageSection | null {
  if (file === null) return null
  return {
    file: file.handle,
    offset: BigInt(HEADER_SIZE + section.offset),
    length: BigInt(section.length),
    pageBytes: section.pageBytes,
    checksums: section.checksums,
  }
}
