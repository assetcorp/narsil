import type { DurabilityConfig, Narsil, NarsilConfig, ReactNativeHost } from '@delali/narsil'
import { DEFAULT_DURABILITY_DIRECTORY } from '../constants'
import type { StreamedMethod } from '../methods'
import { collectStream, fileChunks, resolveAppPath, writeStreamToFile } from './byte-files'

export function withPhoneDurability<T extends { durability?: DurabilityConfig | null }>(
  config: T,
  durabilitySetElsewhere = false,
): Omit<T, 'durability'> & Pick<NarsilConfig, 'durability'> {
  const { durability, ...rest } = config
  if (durability === null || durabilitySetElsewhere) return rest
  return { ...rest, durability: { directory: DEFAULT_DURABILITY_DIRECTORY, ...durability } }
}

export function callStreamed(
  narsil: Narsil,
  host: ReactNativeHost,
  method: StreamedMethod,
  args: readonly unknown[],
): Promise<unknown> {
  const indexName = args[0] as string
  switch (method) {
    case 'snapshot':
      return narsil.snapshot(indexName).then(collectStream)
    case 'exportDocuments':
      return narsil.exportDocuments(indexName).then(collectStream)
    case 'snapshotToFile':
      return narsil
        .snapshot(indexName)
        .then(stream => writeStreamToFile(host.files, stream, resolveAppPath(host, args[1] as string)))
    case 'exportDocumentsToFile':
      return narsil
        .exportDocuments(indexName)
        .then(stream => writeStreamToFile(host.files, stream, resolveAppPath(host, args[1] as string)))
    case 'restoreFromFile':
      return narsil.restore(indexName, fileChunks(host.files, resolveAppPath(host, args[1] as string)))
    case 'importDocumentExportFromFile':
      return narsil.importDocumentExport(indexName, fileChunks(host.files, resolveAppPath(host, args[1] as string)))
  }
}
