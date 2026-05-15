import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { BatchNodeSpec, ClusterConfig } from '../types'

function validateNodeSpec(raw: unknown, index: number): BatchNodeSpec {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Node at index ${index} must be an object.`)
  }

  const record = raw as Record<string, unknown>

  if (typeof record.cn !== 'string' || record.cn.length === 0) {
    throw new Error(`Node at index ${index} is missing required 'cn' field.`)
  }

  if (record.ip !== undefined) {
    if (!Array.isArray(record.ip) || !record.ip.every(v => typeof v === 'string')) {
      throw new Error(`Node at index ${index} has invalid 'ip' field: must be an array of strings.`)
    }
  }

  if (record.dns !== undefined) {
    if (!Array.isArray(record.dns) || !record.dns.every(v => typeof v === 'string')) {
      throw new Error(`Node at index ${index} has invalid 'dns' field: must be an array of strings.`)
    }
  }

  return {
    cn: record.cn,
    ip: record.ip as string[] | undefined,
    dns: record.dns as string[] | undefined,
  }
}

function validateDefaults(raw: unknown): { days?: number; keySize?: 2048 | 4096 } | undefined {
  if (raw === undefined || raw === null) {
    return undefined
  }

  if (typeof raw !== 'object') {
    throw new Error("'defaults' must be an object.")
  }

  const record = raw as Record<string, unknown>
  const result: { days?: number; keySize?: 2048 | 4096 } = {}

  if (record.days !== undefined) {
    if (typeof record.days !== 'number' || !Number.isInteger(record.days) || record.days <= 0) {
      throw new Error("'defaults.days' must be a positive integer.")
    }
    result.days = record.days
  }

  if (record.keySize !== undefined) {
    if (record.keySize !== 2048 && record.keySize !== 4096) {
      throw new Error("'defaults.keySize' must be 2048 or 4096.")
    }
    result.keySize = record.keySize
  }

  return result
}

export async function loadClusterConfig(filePath: string): Promise<ClusterConfig> {
  const content = await readFile(filePath, 'utf-8')
  const ext = extname(filePath).toLowerCase()

  let parsed: unknown
  if (ext === '.json') {
    parsed = JSON.parse(content)
  } else {
    parsed = parseYaml(content)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Cluster config must be an object.')
  }

  const record = parsed as Record<string, unknown>

  if (!Array.isArray(record.nodes)) {
    throw new Error("Cluster config is missing required 'nodes' array.")
  }

  if (record.nodes.length === 0) {
    throw new Error("Cluster config 'nodes' array must contain at least one entry.")
  }

  const nodes: BatchNodeSpec[] = []
  for (let i = 0; i < record.nodes.length; i++) {
    nodes.push(validateNodeSpec(record.nodes[i], i))
  }

  const defaults = validateDefaults(record.defaults)

  return { nodes, defaults }
}
