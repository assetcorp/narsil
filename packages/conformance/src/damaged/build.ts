export interface CheckpointBuild {
  open: 'checkpoint'
  name: string
  rule: string
  index: string
  files: Map<string, Uint8Array>
  fitManifest: boolean
  code: string | null
  remove?: string
  search?: string
}

export interface FileBuild {
  open: 'archive' | 'export'
  name: string
  rule: string
  index: string
  bytes: Uint8Array
  gzip: boolean
  code: string | null
  line?: { line: number; imported: number }
}

export type CaseBuild = CheckpointBuild | FileBuild

export function damagedCheckpoint(
  name: string,
  rule: string,
  code: string | null,
  index: string,
  files: Record<string, Uint8Array>,
  fitManifest = true,
): CheckpointBuild {
  return { open: 'checkpoint', name, rule, index, files: new Map(Object.entries(files)), fitManifest, code }
}
