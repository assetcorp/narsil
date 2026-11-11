import { NOTES_INDEX_PREFIX } from './constants.ts'

export function isNotesIndex(name: string): boolean {
  return name.startsWith(NOTES_INDEX_PREFIX)
}

export function validProxyPath(path: string): boolean {
  try {
    return (
      path.startsWith('/') &&
      path
        .slice(1)
        .split('/')
        .every(segment => {
          const decoded = decodeURIComponent(segment)
          return decoded.length > 0 && decoded !== '.' && decoded !== '..' && !/[/\\?#]/.test(decoded)
        })
    )
  } catch {
    return false
  }
}

export function notesRequestScope(path: string, method: string): { indexName: string; syncAllowed: boolean } | null {
  const segments = path.split('/')
  if (segments[1] !== 'indexes' || segments[2] === undefined) return null
  const indexName = decodeURIComponent(segments[2])
  if (!isNotesIndex(indexName)) return null
  const suffix = segments.slice(3).join('/')
  const syncAllowed =
    (method === 'GET' && (suffix === 'sync/feed' || suffix === 'sync/snapshot')) ||
    ((method === 'PUT' || method === 'GET') && /^documents\/[^/]+$/.test(suffix))
  return { indexName, syncAllowed }
}
