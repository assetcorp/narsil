import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_BACKUP_KEY_PREFIX_LENGTH, MAX_BACKUP_NAME_LENGTH } from './constants'

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const CLAIM_KEY = 'cluster'
const MANIFESTS_DIRECTORY = 'backups/'
const FILES_DIRECTORY = 'files/'

export interface BackupKeys {
  prefix: string
  claim: string
  manifests: string
  files: string
  manifest: (backupName: string) => string
  file: (sha256: string) => string
}

export function validateBackupName(backupName: unknown): string {
  if (typeof backupName !== 'string' || backupName.length > MAX_BACKUP_NAME_LENGTH || !NAME_PATTERN.test(backupName)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `A backup name holds from 1 to ${MAX_BACKUP_NAME_LENGTH} letters, digits, '.', '_', and '-', and starts with a letter or a digit`,
      { backupName: typeof backupName === 'string' ? backupName.slice(0, MAX_BACKUP_NAME_LENGTH) : typeof backupName },
    )
  }
  return backupName
}

export function validateBackupKeyPrefix(keyPrefix: unknown): string {
  const valid =
    typeof keyPrefix === 'string' &&
    keyPrefix.length <= MAX_BACKUP_KEY_PREFIX_LENGTH &&
    keyPrefix.split('/').every(segment => PREFIX_SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..')
  if (!valid) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `A backup key prefix holds up to ${MAX_BACKUP_KEY_PREFIX_LENGTH} characters in segments joined by '/', where each segment holds letters, digits, '.', '_', and '-', and no segment is '.' or '..'`,
      {
        keyPrefix: typeof keyPrefix === 'string' ? keyPrefix.slice(0, MAX_BACKUP_KEY_PREFIX_LENGTH) : typeof keyPrefix,
      },
    )
  }
  return keyPrefix
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
}

export function backupKeys(keyPrefix: string): BackupKeys {
  const prefix = `${validateBackupKeyPrefix(keyPrefix)}/`
  return {
    prefix,
    claim: `${prefix}${CLAIM_KEY}`,
    manifests: `${prefix}${MANIFESTS_DIRECTORY}`,
    files: `${prefix}${FILES_DIRECTORY}`,
    manifest: backupName => `${prefix}${MANIFESTS_DIRECTORY}${validateBackupName(backupName)}`,
    file: sha256 => {
      if (!isSha256Hex(sha256)) {
        throw new NarsilError(ErrorCodes.BACKUP_DAMAGED, 'A backup lists a file under a digest that is not SHA-256', {
          sha256: String(sha256).slice(0, 80),
        })
      }
      return `${prefix}${FILES_DIRECTORY}${sha256}`
    },
  }
}
