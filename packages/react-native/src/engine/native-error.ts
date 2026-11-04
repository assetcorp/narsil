const NATIVE_ERROR_CODE = /^[^[]*\[(E[A-Z0-9_]+)\]/

export function withNativeCode(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if ((error as { code?: unknown }).code !== undefined) return error
  const match = NATIVE_ERROR_CODE.exec(error.message)
  if (match === null) return error
  Object.defineProperty(error, 'code', { value: match[1], enumerable: true, configurable: true, writable: true })
  return error
}
