import { ErrorCodes, NarsilError } from '../errors'

const DIST_SEGMENT = '/dist/'

export function resolveWorkerEntry(moduleUrl: string, sourceDirectory: RegExp, distEntry: string): string | null {
  const distIndex = moduleUrl.lastIndexOf(DIST_SEGMENT)
  const entry =
    distIndex !== -1
      ? new URL(distEntry, moduleUrl.slice(0, distIndex + DIST_SEGMENT.length)).href
      : sourceDirectory.test(moduleUrl)
        ? moduleUrl.replace(sourceDirectory, `${DIST_SEGMENT}${distEntry}`)
        : null
  return entry === moduleUrl ? null : entry
}

export function missingWorkerEntry(moduleUrl: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The engine finds no worker entry beside its own module at "${moduleUrl}", which happens where a bundler folds @delali/narsil into an application bundle. Keep @delali/narsil outside the bundle, or set workers.enabled to false`,
    { moduleUrl },
  )
}
