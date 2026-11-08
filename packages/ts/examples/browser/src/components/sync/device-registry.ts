import * as v from 'valibot'
import {
  MAX_DEVICE_NAME_LENGTH,
  NOTES_DEVICE_LOCK_PREFIX,
  NOTES_DEVICE_REGISTRY_KEY,
  NOTES_SPACE_KEY,
} from './constants'

const DeviceNameSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_DEVICE_NAME_LENGTH),
  v.check(name => /^[a-z0-9]/.test(name) && !/[^a-z0-9-]/.test(name)),
)
const NOTES_SPACE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const DEVICE_NAME_RULE = `Use up to ${MAX_DEVICE_NAME_LENGTH} lowercase letters, digits, and hyphens, starting with a letter or a digit.`

export function normaliseDeviceName(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isValidDeviceName(name: string): boolean {
  return v.is(DeviceNameSchema, name)
}

export function isValidNotesSpace(space: string): boolean {
  return NOTES_SPACE_PATTERN.test(space)
}

export function deviceLockName(space: string, device: string): string {
  return `${NOTES_DEVICE_LOCK_PREFIX}${space}:${device}`
}

export function listKnownDevices(): string[] {
  try {
    const raw = localStorage.getItem(NOTES_DEVICE_REGISTRY_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && isValidDeviceName(entry))
  } catch {
    return []
  }
}

export function rememberDevice(name: string): void {
  try {
    const devices = listKnownDevices()
    if (devices.includes(name)) return
    localStorage.setItem(NOTES_DEVICE_REGISTRY_KEY, JSON.stringify([...devices, name].sort()))
  } catch {}
}

export async function listDevicesHeldElsewhere(): Promise<ReadonlySet<string>> {
  const held = new Set<string>()
  try {
    const space = localStorage.getItem(NOTES_SPACE_KEY)
    if (space === null || !isValidNotesSpace(space)) return held
    const prefix = deviceLockName(space, '')
    const state = await navigator.locks.query()
    for (const lock of state.held ?? []) {
      if (lock.name?.startsWith(prefix)) held.add(lock.name.slice(prefix.length))
    }
  } catch {}
  return held
}
