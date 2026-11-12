import { ErrorCodes, NarsilError } from '../errors'

/** Builds the path for one index. It encodes the name so that a name holding a
 * slash or a question mark cannot reach a route the caller never asked for. */
export function indexPath(indexName: string): string {
  return `/indexes/${encodeURIComponent(indexName)}`
}

/** Builds the path for one document. It encodes the index name and the id, so
 * an id holding a slash reaches the document it names. */
export function documentPath(indexName: string, docId: string): string {
  return `${indexPath(indexName)}/documents/${encodeURIComponent(docId)}`
}

export function socketUrlOf(base: string, path: string): string {
  const location = (globalThis as { location?: { href?: string } }).location?.href
  let parsed: URL
  try {
    parsed = location === undefined ? new URL(base) : new URL(base, location)
  } catch {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The client cannot resolve "${base}" to a server`, { url: base })
  }
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  parsed.search = ''
  parsed.hash = ''
  return `${parsed.toString().replace(/\/+$/, '')}${path}`
}

export function backupPath(backupName: string): string {
  return `/backups/${encodeURIComponent(backupName)}`
}

/** Builds the path for one task record, encoding the id as the other two do. */
export function taskPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`
}
