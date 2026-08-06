import type { ColumnDef, VisibilityState } from '@tanstack/react-table'
import type { ListedDocument } from '../../backend'

export const ID_COLUMN = 'id'

export function readFieldPath(document: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return document[path]
  let current: unknown = document
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function parentPaths(path: string): string[] {
  const segments = path.split('.')
  const parents: string[] = []
  for (let i = 1; i < segments.length; i++) parents.push(segments.slice(0, i).join('.'))
  return parents
}

export function collectFieldPaths(documents: readonly ListedDocument[], schemaPaths: readonly string[]): string[] {
  const paths: string[] = []
  const seen = new Set<string>([ID_COLUMN])
  const covered = new Set<string>()

  for (const path of schemaPaths) {
    for (const parent of parentPaths(path)) covered.add(parent)
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }

  for (const entry of documents) {
    for (const field of Object.keys(entry.document)) {
      if (seen.has(field) || covered.has(field)) continue
      seen.add(field)
      paths.push(field)
    }
  }

  return paths
}

export function buildDocumentColumns(
  fieldPaths: readonly string[],
  sortablePaths: ReadonlySet<string>,
): Array<ColumnDef<ListedDocument>> {
  const columns: Array<ColumnDef<ListedDocument>> = [
    {
      id: ID_COLUMN,
      accessorFn: row => row.id,
      enableHiding: false,
      enableSorting: false,
    },
  ]

  for (const path of fieldPaths) {
    columns.push({
      id: path,
      accessorFn: row => readFieldPath(row.document, path),
      enableSorting: sortablePaths.has(path),
    })
  }

  return columns
}

export function hiddenColumnState(paths: Iterable<string>): VisibilityState {
  const visibility: VisibilityState = {}
  for (const path of paths) visibility[path] = false
  return visibility
}
