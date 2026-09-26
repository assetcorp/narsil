export function resolveWorkerEntry(moduleUrl: string, sourceDirectory: RegExp, distEntry: string): string | null {
  const distIndex = moduleUrl.lastIndexOf('/dist/')
  const entry =
    distIndex !== -1
      ? new URL(distEntry, moduleUrl.slice(0, distIndex + 6)).href
      : sourceDirectory.test(moduleUrl)
        ? moduleUrl.replace(sourceDirectory, `/dist/${distEntry}`)
        : null
  return entry === moduleUrl ? null : entry
}
