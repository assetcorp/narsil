export const SPEC_VERSION = '1.1'
export const BM25_TUNING_SPEC_VERSION = '1.1'

const VERSION_PATTERN = /^(\d+)\.(\d+)$/

function versionPartsOf(version: string): [number, number] | null {
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? [major, minor] : null
}

export function reachesVersion(version: unknown, minimum: string): boolean {
  if (typeof version !== 'string') return false
  const parts = versionPartsOf(version)
  const required = versionPartsOf(minimum)
  if (parts === null || required === null) return false
  return parts[0] > required[0] || (parts[0] === required[0] && parts[1] >= required[1])
}

function majorOf(version: string): number | null {
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

export function sharesMajorVersion(version: unknown, reference: string = SPEC_VERSION): boolean {
  if (typeof version !== 'string') return false
  const major = majorOf(version)
  return major !== null && major === majorOf(reference)
}
