import { coreHostPart } from './core'
import { frozenWritesHostPart } from './frozen-writes'
import { geoHostPart } from './geo'
import { schemaHostPart } from './schema'
import { searchHostPart } from './search'
import { segmentsHostPart } from './segments'
import { smallLeavesHostPart } from './small-leaves'
import { storageHostPart } from './storage'
import { textHostPart } from './text'
import { vectorHostPart } from './vector'
import { workersHostPart } from './workers'
import { writesHostPart } from './writes'

function buildOptionalCodeHost() {
  return {
    ...coreHostPart(),
    ...frozenWritesHostPart(),
    ...geoHostPart(),
    ...schemaHostPart(),
    ...searchHostPart(),
    ...textHostPart(),
    ...segmentsHostPart(),
    ...smallLeavesHostPart(),
    ...storageHostPart(),
    ...vectorHostPart(),
    ...workersHostPart(),
    ...writesHostPart(),
  }
}

export type OptionalCodeHost = ReturnType<typeof buildOptionalCodeHost>

let built: OptionalCodeHost | null = null

export function optionalCodeHost(): OptionalCodeHost {
  built ??= buildOptionalCodeHost()
  return built
}
