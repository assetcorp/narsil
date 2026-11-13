import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKLOAD_ROOT } from '../paths'
import { MANIFEST_FILE, verifyWorkload, type WorkloadManifest } from './format'
import { type WorkloadSize, workloadSettings } from './settings'

export interface ResolvedWorkload {
  directory: string
  manifest: WorkloadManifest
}

function settingsMatch(manifest: WorkloadManifest, size: WorkloadSize): boolean {
  return JSON.stringify(manifest.settings) === JSON.stringify(workloadSettings(size))
}

export async function resolveWorkload(named: string | null, size: WorkloadSize): Promise<ResolvedWorkload> {
  if (named !== null) return { directory: named, manifest: await verifyWorkload(named) }
  const directory = resolve(WORKLOAD_ROOT, size)
  if (existsSync(resolve(directory, MANIFEST_FILE))) {
    try {
      const manifest = await verifyWorkload(directory)
      if (settingsMatch(manifest, size)) return { directory, manifest }
      console.log(`The workload in ${directory} carries other settings, so the suite writes it again`)
    } catch (error) {
      console.log(`The workload in ${directory} failed its check, so the suite writes it again: ${String(error)}`)
    }
  }
  console.log(`Writing the ${size} workload to ${directory}`)
  const { prepareBeirWorkload } = await import('./prepare')
  await prepareBeirWorkload(directory, size)
  return { directory, manifest: await verifyWorkload(directory) }
}
