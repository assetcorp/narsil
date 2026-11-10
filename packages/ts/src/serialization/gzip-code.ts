type GzipCode = typeof import('#platform/gzip')

let loading: Promise<GzipCode> | null = null

export function loadGzip(): Promise<GzipCode> {
  loading ??= import('#platform/gzip').catch((cause: unknown) => {
    loading = null
    throw cause
  })
  return loading
}
