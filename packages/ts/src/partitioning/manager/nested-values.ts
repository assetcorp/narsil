/**
 * Writes a value at a dotted path, building the objects the path walks
 * through where they are absent.
 *
 * @param obj - The object the write lands in, which this changes in place.
 * @param path - The field path, with dots between segments.
 * @param value - What the last segment holds afterwards.
 */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.includes('.')) {
    obj[path] = value
    return
  }
  const segments = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    let next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') {
      next = {}
      current[segments[i]] = next
    }
    current = next as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}
