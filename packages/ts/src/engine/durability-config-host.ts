import type { OptionalCodeHost } from './optional-code-host'

export { ErrorCodes, NarsilError } from '../errors'
export { MAX_FILE_BYTES } from '../serialization/constants'

export function bindDurabilityConfigHost(_host: OptionalCodeHost): void {}
