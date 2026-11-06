import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'

const C_COLUMN_LIMIT = 120
const C_INDENT = '  '

export function numberLines(values: readonly number[]): string {
  const lines: string[] = []
  let line = C_INDENT
  for (const value of values) {
    const piece = `${value},`
    if (line.length + piece.length + 1 > C_COLUMN_LIMIT && line.trim().length > 0) {
      lines.push(line.trimEnd())
      line = C_INDENT
    }
    line += line.trim().length === 0 ? piece : ` ${piece}`
  }
  if (line.trim().length > 0) lines.push(line.trimEnd())
  return lines.join('\n')
}

export function constArray(type: string, name: string, values: readonly number[]): string {
  if (values.length === 0) throw new Error(`${name} would hold no values, which C forbids for an array`)
  return `const ${type} ${name}[${values.length}] = {\n${numberLines(values)}\n};\nconst uint32_t ${name}_length = ${values.length};\n`
}

export interface GeneratedFile {
  path: string
  text: string
}

export function writeOrCheck(files: GeneratedFile[], packageDirectory: string, write: boolean): number {
  const stale: string[] = []
  for (const file of files) {
    const current = existsSync(file.path) ? readFileSync(file.path, 'utf-8') : null
    if (current === file.text) continue
    if (write) {
      writeFileSync(file.path, file.text)
      console.log(`wrote ${relative(packageDirectory, file.path)}`)
    } else {
      stale.push(relative(packageDirectory, file.path))
    }
  }
  if (stale.length === 0) return 0
  for (const path of stale) console.error(`${path} differs from what the generator produces`)
  return 1
}
