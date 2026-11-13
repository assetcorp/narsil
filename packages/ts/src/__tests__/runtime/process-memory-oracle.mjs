import { readFileSync } from 'node:fs'

const KIBIBYTE_BYTES = 1024

export function kibibyteField(text, field) {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(text)
  if (match === null) throw new Error(`The kernel reports no ${field} field`)
  return Number(match[1]) * KIBIBYTE_BYTES
}

export function processStatus() {
  const status = readFileSync('/proc/self/status', 'latin1')
  return {
    unbackedBytes: kibibyteField(status, 'RssAnon') + kibibyteField(status, 'RssShmem'),
    fileBytes: kibibyteField(status, 'RssFile'),
  }
}

export function memoryThatNoFileBacks() {
  return processStatus().unbackedBytes
}
