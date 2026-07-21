import type { Migration } from '@delali/sirannon-db'

const MIGRATION_FILE_PATTERN = /^(\d{3})_(\w+)\.(up|down)\.sql$/

const migrationFiles = import.meta.glob<string>('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

interface MigrationUnit {
  version: number
  name: string
  up?: string
  down?: string
}

function unitFor(units: Map<number, MigrationUnit>, version: number, name: string, path: string): MigrationUnit {
  const existing = units.get(version)
  if (!existing) {
    const created: MigrationUnit = { version, name }
    units.set(version, created)
    return created
  }
  if (existing.name !== name) {
    throw new Error(`Chat migration version ${version} has two names: "${existing.name}" and "${name}" (${path})`)
  }
  return existing
}

function collectUnits(): MigrationUnit[] {
  const units = new Map<number, MigrationUnit>()
  for (const [path, sql] of Object.entries(migrationFiles)) {
    const filename = path.slice(path.lastIndexOf('/') + 1)
    const match = MIGRATION_FILE_PATTERN.exec(filename)
    if (!match) {
      throw new Error(`Chat migration file "${filename}" must be named NNN_name.up.sql or NNN_name.down.sql`)
    }
    const version = Number.parseInt(match[1], 10)
    if (version <= 0) {
      throw new Error(`Chat migration file "${filename}" must use a version of 001 or higher`)
    }
    const unit = unitFor(units, version, match[2], path)
    const direction = match[3] as 'up' | 'down'
    if (unit[direction] !== undefined) {
      throw new Error(`Chat migration version ${version} has more than one ${direction} file`)
    }
    if (sql.trim().length === 0) {
      throw new Error(`Chat migration file "${filename}" is empty`)
    }
    unit[direction] = sql
  }
  return [...units.values()].sort((a, b) => a.version - b.version)
}

export function chatMigrations(): Migration[] {
  const units = collectUnits()
  if (units.length === 0) {
    throw new Error('No chat migration files were bundled from src/lib/chat/migrations')
  }
  return units.map(unit => {
    if (unit.up === undefined) {
      throw new Error(`Chat migration version ${unit.version} (${unit.name}) is missing its up file`)
    }
    return { version: unit.version, name: unit.name, up: unit.up, down: unit.down }
  })
}
