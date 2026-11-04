import { isTransferredError, type TransferredError } from './transferred'

const NARSIL_ERROR_MARKER = Symbol.for('@delali/narsil.NarsilError')
const NARSIL_ERROR_NAME = 'NarsilError'
const NATIVE_DEPENDENCY_MISSING = 'NATIVE_DEPENDENCY_MISSING'

const NATIVE_DEPENDENCY_MISSING_MESSAGE =
  'This app build does not include the Narsil native module, as happens in Expo Go and on 32-bit Android. Install `@delali/narsil-react-native` and `react-native-nitro-modules`, then make a development build with `npx expo run:ios` or `npx expo run:android`, or, in an app without Expo, run `pod install` in the `ios` folder and rebuild the app for each platform.'

/**
 * An error that the engine raised, as it reaches the app's JS thread. `code`
 * holds the engine's error code, such as `INDEX_NOT_FOUND`, and `details`
 * holds the values behind the failure.
 *
 * @public
 */
export interface PhoneNarsilError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
}

/**
 * Reports whether a value is an error that the Narsil engine raised, whether
 * it reached the app from the engine's runtime or from this package.
 *
 * @param value - Anything that a rejected promise or a `catch` block holds.
 * @returns True when the value carries a Narsil error code.
 *
 * @public
 */
export function isNarsilError(value: unknown): value is PhoneNarsilError {
  return typeof value === 'object' && value !== null && NARSIL_ERROR_MARKER in value
}

function narsilError(message: string, code: string, details: Record<string, unknown>): PhoneNarsilError {
  const error = new Error(message)
  error.name = NARSIL_ERROR_NAME
  Object.defineProperty(error, 'code', { value: code, enumerable: true })
  Object.defineProperty(error, 'details', { value: details, enumerable: true })
  Object.defineProperty(error, NARSIL_ERROR_MARKER, { value: true })
  return error as PhoneNarsilError
}

export function nativeDependencyMissing(cause: unknown): PhoneNarsilError {
  return narsilError(NATIVE_DEPENDENCY_MISSING_MESSAGE, NATIVE_DEPENDENCY_MISSING, {
    cause: cause instanceof Error ? cause.message : String(cause),
  })
}

export function rebuiltError(transferred: TransferredError): Error {
  const details = rebuiltValue(transferred.details)
  if (transferred.name === NARSIL_ERROR_NAME && transferred.code !== undefined) {
    const record = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}
    return narsilError(transferred.message, transferred.code, record)
  }
  const error = new Error(transferred.message)
  error.name = transferred.name
  if (transferred.code !== undefined)
    Object.defineProperty(error, 'code', { value: transferred.code, enumerable: true })
  if (details !== undefined) Object.defineProperty(error, 'details', { value: details, enumerable: true })
  return error
}

export function rebuiltValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (isTransferredError(value)) return rebuiltError(value)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value
  if (Array.isArray(value)) return value.map(rebuiltValue)
  const record: Record<string, unknown> = {}
  for (const key of Object.keys(value)) record[key] = rebuiltValue((value as Record<string, unknown>)[key])
  return record
}
