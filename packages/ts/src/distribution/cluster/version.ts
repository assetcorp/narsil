export const SPEC_VERSION = '1.0'

const VERSION_PATTERN = /^(\d+)\.(\d+)$/

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
