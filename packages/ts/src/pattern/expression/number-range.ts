function digitAt(text: string, at: number): number {
  return text.charCodeAt(at) - 0x30
}

function sameWidth(low: string, high: string): string {
  const width = low.length
  if (low === high) return low
  if (/^0+$/.test(low) && /^9+$/.test(high)) return width === 1 ? '[0-9]' : `[0-9]{${width}}`
  if (width === 1) return `[${low}-${high}]`
  if (low[0] === high[0]) return low[0] + sameWidth(low.slice(1), high.slice(1))
  const parts = [low[0] + sameWidth(low.slice(1), '9'.repeat(width - 1))]
  const lowLead = digitAt(low, 0)
  const highLead = digitAt(high, 0)
  if (lowLead + 1 <= highLead - 1) parts.push(`[${lowLead + 1}-${highLead - 1}]${'[0-9]'.repeat(width - 1)}`)
  parts.push(high[0] + sameWidth('0'.repeat(width - 1), high.slice(1)))
  return `(${parts.join('|')})`
}

export function numberRange(low: string, high: string): string {
  if (low.length === high.length) return sameWidth(low, high)
  const highest = Number(high)
  const parts: string[] = []
  let start = Number(low)
  const widest = String(highest).length
  for (let width = String(start).length; width <= widest; width++) {
    const last = Math.min(highest, 10 ** width - 1)
    parts.push(sameWidth(String(start), String(last)))
    start = 10 ** width
  }
  return `(${parts.join('|')})`
}

export function compareDigits(low: string, high: string): number {
  return Number(low) - Number(high)
}
