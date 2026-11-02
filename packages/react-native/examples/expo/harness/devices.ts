import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const APP_ID = 'com.sondelali.narsil.check'
const COPIED_HARNESS_URL_PATH = 'Documents/narsil-harness-url.txt'
const ANDROID_ACTIVITY = `${APP_ID}/.MainActivity`

export interface PhoneDriver {
  readonly platform: 'ios' | 'android'
  launch(): Promise<void>
  kill(): Promise<void>
}

export function androidDriver(serial: string): PhoneDriver {
  const adb = (...args: string[]) => run('adb', ['-s', serial, ...args])
  return {
    platform: 'android',
    async launch() {
      await adb('reverse', 'tcp:8787', 'tcp:8787')
      await adb('shell', 'am', 'start', '-W', '-n', ANDROID_ACTIVITY)
    },
    async kill() {
      await adb('shell', 'am', 'force-stop', APP_ID)
    },
  }
}

function launchedProcessId(jsonPath: string): number {
  const output = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    result?: { process?: { processIdentifier?: unknown } }
  }
  const pid = output.result?.process?.processIdentifier
  if (typeof pid !== 'number') throw new Error('devicectl reported no process identifier for the launched app')
  return pid
}

const LOCKED_PHONE_LAUNCH_WINDOW_MS = 120_000
const LOCKED_PHONE_RETRY_PAUSE_MS = 4_000

async function macAddressTowards(phoneHost: string): Promise<string> {
  const phone = await lookup(phoneHost, { family: 4 })
  const { stdout: route } = await run('route', ['-n', 'get', phone.address])
  const networkInterface = /interface:\s*(\S+)/.exec(route)?.[1]
  if (networkInterface === undefined) throw new Error(`No route reaches ${phoneHost} at ${phone.address}`)
  const { stdout: address } = await run('ipconfig', ['getifaddr', networkInterface])
  const mac = address.trim()
  if (mac.length === 0) throw new Error(`${networkInterface} has no IPv4 address`)
  return mac
}

async function copyHarnessUrl(device: string, directory: string, url: string): Promise<void> {
  const source = join(directory, 'narsil-harness-url.txt')
  writeFileSync(source, url)
  await run('xcrun', [
    'devicectl',
    'device',
    'copy',
    'to',
    '--device',
    device,
    '--source',
    source,
    '--destination',
    COPIED_HARNESS_URL_PATH,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    APP_ID,
  ])
}

async function launchOnIos(device: string, phoneHost: string, port: number): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), 'narsil-launch-'))
  const jsonPath = join(directory, 'launch.json')
  try {
    await copyHarnessUrl(device, directory, `http://${await macAddressTowards(phoneHost)}:${port}`)
    await run('xcrun', [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      device,
      '--terminate-existing',
      '--json-output',
      jsonPath,
      APP_ID,
    ])
    return launchedProcessId(jsonPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function iosDriver(device: string, phoneHost: string, port: number): PhoneDriver {
  let pid: number | null = null
  return {
    platform: 'ios',
    async launch() {
      const deadline = Date.now() + LOCKED_PHONE_LAUNCH_WINDOW_MS
      for (;;) {
        try {
          pid = await launchOnIos(device, phoneHost, port)
          return
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, LOCKED_PHONE_RETRY_PAUSE_MS))
        }
      }
    },
    async kill() {
      if (pid === null) throw new Error('The harness has launched no app to end')
      await run('xcrun', [
        'devicectl',
        'device',
        'process',
        'signal',
        '--device',
        device,
        '--pid',
        String(pid),
        '--signal',
        'SIGKILL',
      ])
      pid = null
    },
  }
}
