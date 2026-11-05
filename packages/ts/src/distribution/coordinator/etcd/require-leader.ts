import type { CallProperties } from '@grpc/grpc-js'

const ETCD_WATCH_METHOD_PATH = '/etcdserverpb.Watch/Watch'
const ETCD_REQUIRE_LEADER_METADATA_KEY = 'hasleader'
const ETCD_REQUIRE_LEADER_METADATA_VALUE = 'true'

export function requireLeaderOnWatchStreams<Request, Response>(
  properties: CallProperties<Request, Response>,
): CallProperties<Request, Response> {
  if (properties.methodDefinition.path !== ETCD_WATCH_METHOD_PATH) return properties
  const metadata = properties.metadata.clone()
  metadata.set(ETCD_REQUIRE_LEADER_METADATA_KEY, ETCD_REQUIRE_LEADER_METADATA_VALUE)
  return { ...properties, metadata }
}
