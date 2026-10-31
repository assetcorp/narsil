import type { BM25Params } from '../../../types/schema'
import type { SynonymRule } from '../../../types/synonyms'

/**
 * Changes the search settings of a live index across a cluster.
 *
 * @public
 */
export interface ClusterNodeSearchSettings {
  /**
   * Replaces the synonym set of an index across the cluster, so that every
   * search that starts after the promise resolves expands its words with the
   * new set.
   *
   * The node stores the set in the coordinator before it asks each node that
   * holds a partition of the index to apply the set. The promise resolves
   * once every one of those nodes answers. Pass an empty list to remove the
   * set.
   *
   * @param indexName - The index whose set the cluster replaces.
   * @param synonyms - The new set, in the shape that {@link SynonymRule}
   * describes.
   * @throws A `NarsilError` with `CONFIG_INVALID` when a rule breaks that
   * shape, when a word analyses to no token or to more than one, or when the
   * set passes 100,000 rules, 500,000 words, or 4,194,304 bytes of words in
   * UTF-8. It throws `CLUSTER_WRITE_BLOCKED` when the index metadata changes
   * between the node's read and its write on every one of its tries, and
   * `QUERY_NODE_TIMEOUT` when a node holding a partition gives no answer.
   * After a timeout, the coordinator keeps the new set, so a retry of the
   * same call can finish applying it.
   */
  updateSynonyms(indexName: string, synonyms: SynonymRule[]): Promise<void>
  /**
   * Returns the synonym set that the coordinator holds for an index, with
   * every word as the caller wrote it, or an empty list when the index holds
   * no set.
   *
   * @param indexName - The index whose set the node returns.
   * @throws A `NarsilError` with `INDEX_NOT_FOUND` when the cluster holds no
   * index under that name.
   */
  getSynonyms(indexName: string): Promise<SynonymRule[]>
  /**
   * Replaces the BM25 setting of an index across the cluster, so that this
   * node scores every search that starts after the promise resolves under the
   * new setting.
   *
   * The call replaces the whole setting, and `{}` clears it. The promise
   * resolves once the coordinator stores the setting and this node applies it.
   * Every other node follows through its watch of the index metadata, so a
   * search that another node coordinates can use the old setting for that
   * time.
   *
   * @param indexName - The index whose setting the node replaces.
   * @param bm25 - The new setting, in the shape that {@link BM25Params} describes.
   * @throws A `NarsilError` with `CONFIG_INVALID` when a value breaks that
   * shape, with `INDEX_NOT_FOUND` when the cluster holds no index under that
   * name, with `BM25_NOT_READY` while a registered node has a specification
   * version below 1.1, and with `CLUSTER_WRITE_BLOCKED` when other writes keep
   * changing the index metadata.
   */
  updateBM25(indexName: string, bm25: BM25Params): Promise<void>
}
