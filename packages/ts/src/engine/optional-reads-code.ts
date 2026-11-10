import { ErrorCodes, NarsilError } from '../errors'
import { schemaMayDeclare } from '../schema/declared-types'
import { optionalCodeHost } from './optional-code-host'

type OptionalReads = typeof import('./optional-reads')

const TYPES_THAT_FOLD_OR_EXPAND = ['pattern', 'verbatim', 'partial'] as const

let loaded: OptionalReads | null = null
let loading: Promise<OptionalReads> | null = null

export function importOptionalReads(): Promise<OptionalReads> {
  if (loaded !== null) return Promise.resolve(loaded)
  loading ??= import('./optional-reads').then(
    code => {
      code.bindOptionalReadsHost(optionalCodeHost())
      loaded = code
      return code
    },
    (cause: unknown) => {
      loading = null
      throw cause
    },
  )
  return loading
}

export function loadOptionalReadsFor(schema: unknown): Promise<OptionalReads> | null {
  if (loaded !== null) return null
  return TYPES_THAT_FOLD_OR_EXPAND.some(type => schemaMayDeclare(schema, type)) ? importOptionalReads() : null
}

export function requireLoadedOptionalReads(): OptionalReads {
  if (loaded === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The engine reached the read features before it loaded them')
  }
  return loaded
}
