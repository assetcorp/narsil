import type * as DigestCode from '../durability/digest-leaf'

type DigestNames = Pick<typeof DigestCode, 'sha256'>

export let sha256: DigestNames['sha256']

export function bindDigestNames(digest: DigestNames): void {
  ;({ sha256 } = digest)
}
