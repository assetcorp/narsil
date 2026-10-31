import { batchBodyKindOf } from '../batch-scan'
import type { ResolvedLimits } from '../deps'
import type { ParsedBodyKind } from '../parse-heap'
import type { RouteOptions } from '../request'

const writeBodyKind = (): ParsedBodyKind => 'write'
const readBodyKind = (): ParsedBodyKind => 'read'

export interface SharedRouteOptions {
  probe: RouteOptions
  bare: RouteOptions
  named: RouteOptions
  namedBody: RouteOptions
  document: RouteOptions
  writeBody: RouteOptions
  readBody: RouteOptions
  batchBody: RouteOptions
  documentWriteBody: RouteOptions
  importBody: RouteOptions
  spooledBody: RouteOptions
  newIndexBody: RouteOptions
}

export function sharedRouteOptions(limits: ResolvedLimits): SharedRouteOptions {
  const { maxBodyBytes, maxImportBytes, maxRestoreBytes } = limits
  const namedBody: RouteOptions = { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }
  const documentBody: RouteOptions = { paramCount: 2, needsBody: true, maxBytes: maxBodyBytes }
  return {
    probe: { maxBytes: 0, skipHooks: true },
    bare: { maxBytes: 0 },
    named: { paramCount: 1, maxBytes: 0 },
    namedBody,
    document: { paramCount: 2, maxBytes: 0 },
    writeBody: { ...namedBody, bodyKind: writeBodyKind },
    readBody: { ...namedBody, bodyKind: readBodyKind },
    batchBody: { ...namedBody, bodyKind: batchBodyKindOf },
    documentWriteBody: { ...documentBody, bodyKind: writeBodyKind },
    importBody: { paramCount: 1, needsBody: true, maxBytes: maxImportBytes },
    spooledBody: { paramCount: 1, spoolsBody: true, maxBytes: maxRestoreBytes },
    newIndexBody: { needsBody: true, maxBytes: maxBodyBytes },
  }
}
