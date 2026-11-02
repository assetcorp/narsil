export interface PosixPath {
  readonly sep: '/'
  isAbsolute(path: string): boolean
  normalize(path: string): string
  join(...segments: string[]): string
  resolve(...segments: string[]): string
  dirname(path: string): string
  basename(path: string, suffix?: string): string
  relative(from: string, to: string): string
}

function normalizeParts(path: string, absolute: boolean): string[] {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  return parts
}

export function createPosixPath(currentDirectory: () => string): PosixPath {
  function isAbsolute(path: string): boolean {
    return path.startsWith('/')
  }

  function normalize(path: string): string {
    if (path.length === 0) return '.'
    const absolute = isAbsolute(path)
    const joined = normalizeParts(path, absolute).join('/')
    if (absolute) return `/${joined}`
    return joined.length === 0 ? '.' : joined
  }

  function resolve(...segments: string[]): string {
    let resolved = ''
    for (let index = segments.length - 1; index >= 0 && !isAbsolute(resolved); index--) {
      const segment = segments[index]
      if (segment === undefined || segment.length === 0) continue
      resolved = resolved.length === 0 ? segment : `${segment}/${resolved}`
    }
    if (!isAbsolute(resolved)) resolved = `${currentDirectory()}/${resolved}`
    return `/${normalizeParts(resolved, true).join('/')}`
  }

  function dirname(path: string): string {
    if (path.length === 0) return '.'
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
    const slash = trimmed.lastIndexOf('/')
    if (slash === -1) return '.'
    if (slash === 0) return '/'
    return trimmed.slice(0, slash)
  }

  function basename(path: string, suffix?: string): string {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    if (suffix !== undefined && suffix !== base && base.endsWith(suffix)) return base.slice(0, -suffix.length)
    return base
  }

  function relative(from: string, to: string): string {
    const fromParts = resolve(from)
      .split('/')
      .filter(part => part.length > 0)
    const toParts = resolve(to)
      .split('/')
      .filter(part => part.length > 0)
    let shared = 0
    while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared++
    return [...fromParts.slice(shared).map(() => '..'), ...toParts.slice(shared)].join('/')
  }

  return {
    sep: '/',
    isAbsolute,
    normalize,
    join: (...segments) => normalize(segments.filter(segment => segment.length > 0).join('/')),
    resolve,
    dirname,
    basename,
    relative,
  }
}
