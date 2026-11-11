export function compareScores(left: number, right: number): number {
  const difference = right - left
  if (!Number.isNaN(difference)) return difference
  if (left === right) return 0
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1
  return -1
}
