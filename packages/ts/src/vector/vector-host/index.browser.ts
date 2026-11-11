import type { OptionalCodeHost } from '../../engine/optional-code-host'
import type * as VectorCoreCode from '../core-leaf'
import { bindEngineNames } from './engine'
import { bindVectorCore1Names } from './vector-core-1'
import { bindVectorCore2Names } from './vector-core-2'

export * from './engine'
export * from './vector-core-1'
export * from './vector-core-2'

export function bindVectorHost(host: OptionalCodeHost, vectorCore: typeof VectorCoreCode): void {
  bindEngineNames(host)
  bindVectorCore1Names(vectorCore)
  bindVectorCore2Names(vectorCore)
}
