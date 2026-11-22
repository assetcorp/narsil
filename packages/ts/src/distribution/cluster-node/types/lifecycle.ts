/**
 * Joins a node to a cluster, and takes it out again either at once or after moving its copies to other nodes.
 *
 * @public
 */
export interface ClusterNodeLifecycle {
  /**
   * Joins the cluster: the node registers, takes on its allocated partitions, and starts serving.
   *
   * The start fails with `NODE_VERSION_INCOMPATIBLE` where the active controller follows a specification version
   * with another major version, because nodes on different major versions cannot share a cluster. A node that finds
   * no active controller joins, and a later controller on another major version gives it no partition.
   *
   * Where the node lacks a copy that the allocation table assigns to it as the primary or as an in-sync replica, the
   * node reports `NODE_COPY_MISSING` to `onError` for that copy and waits until the controller fails the copy over,
   * so that an empty copy never replaces the data that the cluster acknowledged. A node with the `controller` role
   * stands for election while it waits. {@link ClusterNodeLifecycle.shutdown} ends the wait, and the start then rejects
   * with `NODE_NOT_JOINED`.
   */
  start(): Promise<void>
  /**
   * Leaves the cluster for good: the controller moves every copy that the node holds to other nodes, and the node then
   * deregisters and shuts down.
   *
   * The node publishes its registration with `draining` set, so the controller places nothing new on it, hands each
   * partition that it leads to an in-sync replica elsewhere, and moves each of its replicas by adding the new copy
   * before it drops this one. The call returns once no allocation table names the node and
   * {@link ClusterNodeLifecycle.shutdown} has finished. The drain waits for as long as the cluster has no other node that
   * can take a copy, so pass `signal` to give up. An abort rejects with the signal's reason and publishes the
   * registration without `draining`, which stops the drain and leaves the node in the cluster.
   *
   * @param options - Holds `signal`, which ends the wait and keeps the node in the cluster.
   * @returns A promise that settles once the node has left the cluster and shut down.
   */
  decommission(options?: { signal?: AbortSignal }): Promise<void>
  /**
   * Leaves the cluster at once: the node deregisters and closes the engine it ran.
   *
   * The controller treats the node as failed, so it promotes a replica for each partition that the node led and waits
   * `nodeLeftDelayMs` before it moves the node's replicas, which lets a node that restarts in place take them back.
   * Call {@link ClusterNodeLifecycle.decommission} to move the copies off the node first.
   */
  shutdown(): Promise<void>
}
