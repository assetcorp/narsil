/** Builds the path for one index. It encodes the name, so that a name holding a
 * slash or a question mark cannot reach a route the caller never asked for. */
export function indexPath(indexName: string): string {
  return `/indexes/${encodeURIComponent(indexName)}`
}

/** Builds the path for one document, encoding both the index name and the id. */
export function documentPath(indexName: string, docId: string): string {
  return `${indexPath(indexName)}/documents/${encodeURIComponent(docId)}`
}

/** Builds the path for one task record. */
export function taskPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`
}
