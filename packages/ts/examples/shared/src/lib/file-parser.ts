export function parseJsonArray(text: string): Record<string, unknown>[] {
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    throw new Error('JSON must be an array of objects')
  }
  if (parsed.length === 0) {
    throw new Error('JSON array is empty')
  }
  if (typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error('JSON array items must be objects')
  }
  return parsed as Record<string, unknown>[]
}

export function parseCsv(text: string): Record<string, unknown>[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2) {
    throw new Error('CSV needs at least a header row and one data row')
  }

  const headers = parseCsvLine(lines[0])
  const records: Record<string, unknown>[] = []

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i])
    const record: Record<string, unknown> = {}
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j].trim()
      if (!header) continue
      const value = values[j]?.trim() ?? ''
      record[header] = coerceValue(value)
    }
    records.push(record)
  }

  return records
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        result.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }

  result.push(current)
  return result
}

function coerceValue(value: string): unknown {
  if (value === '' || value === 'null' || value === 'NULL') return null
  if (value === 'true' || value === 'TRUE') return true
  if (value === 'false' || value === 'FALSE') return false

  const num = Number(value)
  if (!Number.isNaN(num) && value.trim() !== '') return num

  return value
}

export function parseFile(text: string, filename: string): Record<string, unknown>[] {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json')) return parseJsonArray(text)
  if (lower.endsWith('.csv')) return parseCsv(text)

  try {
    return parseJsonArray(text)
  } catch {
    return parseCsv(text)
  }
}
