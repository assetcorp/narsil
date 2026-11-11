import { schemaMayDeclare } from '../schema/declared-types'

export interface CodeLoader<Code> {
  loaded(): Code | null
  require(): Code
  load(): Promise<Code>
  loadFor(schema: unknown): Promise<Code> | null
}

export function codeLoader<Code>(importCode: () => Promise<Code>, typeName: string): CodeLoader<Code> {
  let loaded: Code | null = null
  let loading: Promise<Code> | null = null
  function load(): Promise<Code> {
    if (loaded !== null) return Promise.resolve(loaded)
    if (loading === null) {
      loading = importCode().then(
        code => {
          loaded = code
          return code
        },
        (err: unknown) => {
          loading = null
          throw err
        },
      )
    }
    return loading
  }
  return {
    loaded: () => loaded,
    require(): Code {
      if (loaded === null) throw new Error(`The engine reached ${typeName} code before it loaded that code`)
      return loaded
    },
    load,
    loadFor: schema => (loaded !== null || !schemaMayDeclare(schema, typeName) ? null : load()),
  }
}
