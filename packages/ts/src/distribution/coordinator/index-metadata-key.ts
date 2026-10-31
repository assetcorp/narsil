const INDEX_METADATA_KEY_ROOT = '_narsil/index'
const INDEX_METADATA_KEY_SUFFIX = '/config'

export const INDEX_METADATA_KEY_PREFIX = `${INDEX_METADATA_KEY_ROOT}/`

export function indexNameOfMetadataSuffix(keySuffix: string): string | null {
  if (!keySuffix.endsWith(INDEX_METADATA_KEY_SUFFIX)) return null
  const indexName = keySuffix.slice(0, -INDEX_METADATA_KEY_SUFFIX.length)
  return indexName.length === 0 || indexName.includes('/') ? null : indexName
}

export function indexNameOfMetadataKey(key: string): string | null {
  if (!key.startsWith(INDEX_METADATA_KEY_PREFIX)) return null
  return indexNameOfMetadataSuffix(key.slice(INDEX_METADATA_KEY_PREFIX.length))
}
