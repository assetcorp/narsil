import type { Etcd3 as Etcd3Client, IKeyValue } from 'etcd3'
import { compareCodePoints } from '../../../core/ordering'
import type { SchemaDefinition } from '../../../types/schema'
import type { ClusterCoordinator, SchemaEvent } from '../types'
import { type CoordinatorKeys, extractSuffix } from './keys'
import type { PrefixWatchHandlers } from './prefix-watch'
import type { EtcdWriteGuard } from './request-size'
import { deserializeSchema, serializeSchema } from './serialization'

export interface StoredValueContext {
  client: Etcd3Client
  keys: CoordinatorKeys
  guard: EtcdWriteGuard
  assertNotShutdown(): void
  watchPrefix(prefix: string, handlers: PrefixWatchHandlers): Promise<() => void>
}

export type StoredValueMethods = Pick<
  ClusterCoordinator,
  'get' | 'compareAndSet' | 'delete' | 'getSchema' | 'putSchema' | 'dropSchema' | 'listSchemas' | 'watchSchemas'
>

export function storedValueMethods(context: StoredValueContext): StoredValueMethods {
  const { client, keys, guard, assertNotShutdown, watchPrefix } = context
  return {
    async get(key: string): Promise<Uint8Array | null> {
      assertNotShutdown()
      const etcdKey = keys.generic(key)
      const buf = await client.get(etcdKey).buffer()
      if (buf === null) {
        return null
      }
      return new Uint8Array(buf)
    },

    async compareAndSet(key: string, expected: Uint8Array | null, value: Uint8Array): Promise<boolean> {
      assertNotShutdown()
      const etcdKey = keys.generic(key)
      const newValue = Buffer.from(value)

      return guard.send({ key: etcdKey, value: newValue, expected }, async () => {
        if (expected === null) {
          const txn = await client.if(etcdKey, 'Create', '==', 0).then(client.put(etcdKey).value(newValue)).commit()
          return txn.succeeded
        }

        const expectedBuf = Buffer.from(expected)
        const txn = await client
          .if(etcdKey, 'Value', '==', expectedBuf)
          .then(client.put(etcdKey).value(newValue))
          .commit()
        return txn.succeeded
      })
    },

    async delete(key: string): Promise<void> {
      assertNotShutdown()
      await client.delete().key(keys.generic(key)).exec()
    },

    async getSchema(indexName: string): Promise<SchemaDefinition | null> {
      assertNotShutdown()
      const key = keys.schema(indexName)
      const buf = await client.get(key).buffer()
      if (buf === null) {
        return null
      }
      return deserializeSchema(buf)
    },

    async putSchema(indexName: string, schema: SchemaDefinition): Promise<void> {
      assertNotShutdown()
      const key = keys.schema(indexName)
      const value = serializeSchema(schema)
      await guard.send({ key, value, expected: null }, () => client.put(key).value(value).exec())
    },

    async dropSchema(indexName: string): Promise<void> {
      assertNotShutdown()
      await client.delete().key(keys.schema(indexName)).exec()
    },

    async listSchemas(): Promise<string[]> {
      assertNotShutdown()
      const prefix = keys.schemaPrefix()
      const result = await client.getAll().prefix(prefix).keys()
      return result.map(fullKey => extractSuffix(fullKey, prefix)).sort(compareCodePoints)
    },

    async watchSchemas(handler: (event: SchemaEvent) => void): Promise<() => void> {
      assertNotShutdown()
      const prefix = keys.schemaPrefix()
      return watchPrefix(prefix, {
        put(kv: IKeyValue) {
          try {
            const schema = deserializeSchema(kv.value)
            handler({ type: 'schema_created', indexName: extractSuffix(kv.key.toString(), prefix), schema })
          } catch (_) {}
        },
        delete(fullKey: string) {
          handler({ type: 'schema_dropped', indexName: extractSuffix(fullKey, prefix), schema: null })
        },
      })
    },
  }
}
