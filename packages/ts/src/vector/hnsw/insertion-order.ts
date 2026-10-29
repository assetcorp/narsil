export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const held = items[i]
    items[i] = items[j]
    items[j] = held
  }
  return items
}
