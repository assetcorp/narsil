import { Platform } from 'react-native'
import { fromBase64, toBase64 } from './base64'

const ANDROID_HARNESS_URL = 'http://localhost:8787'

let readCopiedUrl: () => string | null = () => null
let copiedUrl: string | null | undefined

export function readHarnessUrlWith(read: () => string | null): void {
  readCopiedUrl = read
  copiedUrl = undefined
}

function copiedHarnessUrl(): string | null {
  if (copiedUrl === undefined) copiedUrl = readCopiedUrl()
  return copiedUrl
}

export type PhoneTask =
  | { kind: 'idle' }
  | { kind: 'search' }
  | { kind: 'writes'; directory: string; firstId: number }
  | { kind: 'long-log-writes'; directory: string; documents: number }
  | { kind: 'checkpoint'; directory: string; firstId: number }
  | { kind: 'verify'; directory: string }
  | { kind: 'snapshot-out' }
  | { kind: 'snapshot-in' }
  | { kind: 'errors' }
  | { kind: 'timer'; probesAppThread?: boolean }
  | { kind: 'runtime-costs' }

function harnessUrl(): string {
  const copied = copiedHarnessUrl()
  if (copied !== null) return copied
  const configured = process.env.EXPO_PUBLIC_NARSIL_HARNESS_URL
  if (typeof configured === 'string' && configured.length > 0) return configured
  if (Platform.OS === 'android') return ANDROID_HARNESS_URL
  throw new Error('Set EXPO_PUBLIC_NARSIL_HARNESS_URL to the address of the harness on the computer')
}

async function send(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${harnessUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`The harness answered ${response.status} to ${path}`)
}

export async function nextTask(): Promise<PhoneTask> {
  const response = await fetch(`${harnessUrl()}/task?platform=${Platform.OS}`)
  if (!response.ok) throw new Error(`The harness answered ${response.status} to /task`)
  return (await response.json()) as PhoneTask
}

export function acknowledge(ids: readonly string[]): void {
  send('/ack', { ids }).catch(() => undefined)
}

export function announce(event: string, details: unknown): void {
  send('/event', { event, details }).catch(() => undefined)
}

export function report(kind: string, payload: unknown): Promise<void> {
  return send('/report', { kind, platform: Platform.OS, version: String(Platform.Version), payload })
}

export function upload(name: string, bytes: Uint8Array): Promise<void> {
  return send('/upload', { name, base64: toBase64(bytes) })
}

export async function download(name: string): Promise<Uint8Array> {
  const response = await fetch(`${harnessUrl()}/download?name=${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`The harness answered ${response.status} to /download`)
  const { base64 } = (await response.json()) as { base64: string }
  return fromBase64(base64)
}
