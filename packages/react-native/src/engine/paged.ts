import type { NativeCore, NativePagedFileHandle } from '@delali/narsil'
import type { NarsilCore } from '../specs/core.nitro'
import { withNativeCode } from './native-error'

function methodOf(core: NarsilCore, name: string): (...parameters: unknown[]) => unknown {
  const method: unknown = Reflect.get(core, name)
  if (typeof method !== 'function') throw new Error(`The native search core has no ${name} method.`)
  return (...parameters) => {
    try {
      return Reflect.apply(method, core, parameters)
    } catch (error) {
      throw withNativeCode(error)
    }
  }
}

function statusOf(value: unknown): number {
  if (typeof value !== 'number') throw new Error('The native page operation returned no numeric status.')
  return value
}

function isFile(value: unknown): value is NativePagedFileHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'identity' in value &&
    typeof value.identity === 'bigint' &&
    'length' in value &&
    typeof value.length === 'bigint'
  )
}

function fileOf(value: unknown): NativePagedFileHandle | number {
  if (typeof value === 'number' || isFile(value)) return value
  throw new Error('The native page operation returned an invalid file handle.')
}

export function adaptPaged(
  core: NarsilCore,
): Pick<
  NativeCore,
  | 'openPagedFile'
  | 'closePagedFile'
  | 'readPage'
  | 'readPageAsync'
  | 'readPagedPostings'
  | 'readPagedPositions'
  | 'readPagedRemovals'
  | 'readPagedId'
  | 'readPagedOrdinal'
  | 'readPagedWriteRecord'
  | 'readPagedTotals'
  | 'searchPagedVectors'
  | 'searchPagedVectorsAsync'
> {
  const open = methodOf(core, 'openPagedFile')
  const close = methodOf(core, 'closePagedFile')
  const read = methodOf(core, 'readPage')
  const readAsync = methodOf(core, 'readPageAsync')
  const postings = methodOf(core, 'readPagedPostings')
  const positions = methodOf(core, 'readPagedPositions')
  const removals = methodOf(core, 'readPagedRemovals')
  const id = methodOf(core, 'readPagedId')
  const ordinal = methodOf(core, 'readPagedOrdinal')
  const writeRecord = methodOf(core, 'readPagedWriteRecord')
  const totals = methodOf(core, 'readPagedTotals')
  const search = methodOf(core, 'searchPagedVectors')
  const searchAsync = methodOf(core, 'searchPagedVectorsAsync')
  return {
    openPagedFile: path => fileOf(open(path)),
    closePagedFile: file => statusOf(close(file)),
    readPage: (...parameters) => statusOf(read(...parameters)),
    async readPageAsync(...parameters) {
      try {
        return statusOf(await readAsync(...parameters))
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    readPagedPostings: (...parameters) => statusOf(postings(...parameters)),
    readPagedPositions: (...parameters) => statusOf(positions(...parameters)),
    readPagedRemovals: (...parameters) => statusOf(removals(...parameters)),
    readPagedId: (...parameters) => statusOf(id(...parameters)),
    readPagedOrdinal: (...parameters) => statusOf(ordinal(...parameters)),
    readPagedWriteRecord: (...parameters) => statusOf(writeRecord(...parameters)),
    readPagedTotals: (...parameters) => statusOf(totals(...parameters)),
    searchPagedVectors: (...parameters) => statusOf(search(...parameters)),
    async searchPagedVectorsAsync(...parameters) {
      try {
        return statusOf(await searchAsync(...parameters))
      } catch (error) {
        throw withNativeCode(error)
      }
    },
  }
}
