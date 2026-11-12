const churnByIndex = new Map<string, number>()

export function noteDocumentChurn(indexName: string, documents: number): void {
  if (!(documents > 0)) return
  churnByIndex.set(indexName, (churnByIndex.get(indexName) ?? 0) + documents)
}

export function documentChurnOf(indexName: string): number {
  return churnByIndex.get(indexName) ?? 0
}
