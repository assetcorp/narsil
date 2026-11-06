export function copyStoredValue(value: unknown): unknown {
  return structuredClone(value)
}
