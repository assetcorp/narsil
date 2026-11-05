# Narsil Cluster Backup Specification

A cluster can back up an index to a store outside the cluster through a [PersistenceAdapter](../adapters.md#persistenceadapter), and it can restore that backup as a new index on a cluster of any size. Every backup can be restored without any other backup, while two backups that share a file store that file once.

---

## Store Layout

The operator gives each cluster a key prefix of one or more segments joined by `/`, where each segment holds letters, digits, `.`, `_`, and `-`, and where no segment is `.` or `..`. A node must refuse any other prefix with `CONFIG_INVALID` when it starts. Every key that a cluster writes to the store begins with its prefix:

| Key | Content |
|-----|---------|
| `<keyPrefix>/cluster` | The UTF-8 text of the UUID of the cluster that writes under the prefix |
| `<keyPrefix>/files/<sha256>` | One stored file, under the SHA-256 of its bytes written as 64 lowercase hexadecimal digits |
| `<keyPrefix>/backups/<backupName>` | One [backup manifest](#backup-manifest) |

A backup name holds 1 to 128 characters, where the first is a letter or a digit and the rest are letters, digits, `.`, `_`, and `-`. A node must refuse any other name with `CONFIG_INVALID` before it calls the adapter, so that no name can reach a key outside the prefix.

The controller creates the cluster's UUID the first time that the cluster takes a backup, as a UUID v4 under the coordinator key `_narsil/cluster/uuid`, with compareAndSet against an absent value, and nothing ever changes it.

### The Claim

Two clusters that write under one prefix can delete each other's files, so each cluster claims its prefix. Before a backup starts, before the controller saves a manifest, and before a deletion removes any key, the controller must read `<keyPrefix>/cluster`. Where that key holds nothing, the controller stores its own UUID there with saveIfAbsent, and where that call returns false, it reads the key again. Because a retry can return false for the controller's own write, the controller compares the value that it reads with its own UUID, and it proceeds only where the two match. Where the key holds another cluster's UUID, the controller must refuse the operation with `BACKUP_STORE_CLAIMED`. A restore and a listing read the store without this check, so that a new cluster can restore the backups of a cluster that no longer exists.

A backup store must offer saveIfAbsent, because a save followed by a read can't stop two controllers from both taking an empty claim. A node must refuse a backup store without saveIfAbsent with CONFIG_INVALID when it starts.

---

## Backup Manifest

A backup manifest is a `.nrsl` file whose header sets the checksum flag and carries envelope format version 1, whose compression flag is 0, and whose payload holds this MessagePack map:

```text
BackupManifest {
  name:              string                  (the backup name)
  clusterUuid:       string
  indexName:         string                  (the name that the caller backed up)
  startedAt:         uint64                  (milliseconds since the Unix epoch)
  completedAt:       uint64
  partitionCount:    uint32
  syncEpoch:         string or absent        (the index epoch, which the controller copies from IndexSettings when the backup starts)
  takenBy:           string or absent        ("sync" where device sync started the backup, and absent for a caller's backup)
  replicationFactor: uint32
  constraints:       AllocationConstraints   (as cluster.md defines)
  config:            StoredFile              (an index configuration payload)
  partitions:        List<BackupPartition>   (one per partition, in partitionId order)
}

BackupPartition {
  partitionId: uint32
  lastSeqNo:   uint64
  manifest:    StoredFile                    (a segment manifest of this partition alone)
  files:       List<ListedFile>              (every file that this manifest lists, in its order)
}

StoredFile {
  sha256: string
  bytes:  uint64
}

ListedFile {
  key:    string   (the file's key without its leading <indexName>/)
  sha256: string
  bytes:  uint64
}
```

The bytes of a `StoredFile` or a `ListedFile` are stored under `<keyPrefix>/files/<sha256>`.

A reader must raise `BACKUP_DAMAGED` for a manifest whose compression flag is 1, as it does for any manifest that fails to decode.

Each partition's manifest is the manifest that a [snapshot archive](../durability.md#snapshot-archive) of that one partition holds, and three more rules apply to it:

- The primary must take it from a checkpoint that holds no effect of a log record above `lastSeqNo`, as the snapshot archive requires.
- It carries no `termHistory`, because a restore starts a new history.
- It lists one vector file for each vector file of the primary's checkpoint that holds a live vector of the partition. That file holds those live vectors in the order of its source file, and it holds no dead vector. The primary must build it from the source file, the source file's dead bits, and the partition alone, so that an unchanged source file gives the same bytes and a second backup of an unchanged index stores no new file.

---

## Taking a Backup

```text
1. The node that receives the request checks the backup name, then
   sends cluster.backup to the controller.
2. The controller refuses the request with BACKUP_NOT_READY where any
   registered node has a specification version below 1.2, with
   INDEX_NOT_FOUND where the coordinator holds no metadata for the
   index, with BACKUP_ALREADY_EXISTS where a manifest or a running job
   holds the name, with BACKUP_IN_PROGRESS while a deletion runs, with
   PARTITION_REBALANCING_BACKPRESSURE while a partition count change
   of the index runs, and with BACKUP_STORE_CLAIMED as The Claim
   defines. Otherwise it records the job and answers.
3. The controller sends cluster.backup_partition to the primary of
   every partition of the generation that serves the index.
4. A primary without write-ahead log durability refuses with
   BACKUP_DURABILITY_REQUIRED. Every other primary takes a checkpoint
   after it receives the message, and keeps every file of that
   checkpoint until it finishes. It saves the index configuration
   payload, the partition's manifest, and every file that the
   manifest lists, and it skips each one whose key a list of
   <keyPrefix>/files/ already returns.
5. Where the controller promotes a new primary for a partition before
   that partition finishes, it sends cluster.backup_partition to the
   new primary, which starts the partition again.
6. Once every partition has finished, the controller checks with list
   that every file that the manifest names is stored, checks the
   claim again, and saves the manifest.
```

A backup holds every write that each primary acknowledged before it received `cluster.backup_partition`, because the checkpoint of step 4 follows that message. Each partition's content matches its own `lastSeqNo`, and a backup gives no single point in time across partitions.

Saving the manifest is the commit point, so a reader must treat a backup that has no manifest as absent. A failed backup saves no manifest, and the files that it stored stay until a [deletion](#deleting-a-backup) removes them.

The controller copies `takenBy` from `cluster.backup` into the manifest. A node sets `takenBy` only for a backup that [device sync](../sync.md#in-a-cluster) starts, and the backup operation that a caller reaches takes no `takenBy`, so that a caller's backup never carries it.

A primary must stream each file that it saves through `saveStream` where the adapter offers that method, and it must bound the files that it saves at one time, so that a backup can't fill a serving node's memory.

---

## Restoring a Backup

```text
1. The node that receives the request checks the backup name and the
   index name, then sends cluster.backup_restore to the controller.
2. The controller refuses the request with BACKUP_NOT_READY where any
   registered node has a specification version below 1.2, with
   BACKUP_NOT_FOUND where the store holds no manifest under the name,
   with BACKUP_DAMAGED where the manifest fails to decode, with
   BACKUP_IN_PROGRESS while a deletion of the same backup runs, and
   with INDEX_ALREADY_EXISTS where the coordinator holds non-empty
   metadata for the index name. Otherwise it records the job and
   answers.
3. The controller creates a generation named
   narsil-generation-{indexUuid}, with a fresh indexUuid, the
   configuration and the partitionCount of the backup, the constraints that the request names or else the backup's, and a
   replicationFactor of 0, through the creation flow.
4. Once every partition of the generation is ACTIVE, the controller
   sends cluster.restore_partition to the primary of each partition.
5. Each primary reads the partition's manifest, checks its length and
   SHA-256, and refuses with BACKUP_DAMAGED where it is missing or
   differs. It then refuses with RESTORE_MEMORY_EXCEEDED where
   Replacing an Index by Restore requires that, before it reads any
   other file. It reads every other file that its BackupPartition
   lists, checks each file's length and SHA-256, and refuses with
   BACKUP_DAMAGED where any file is missing or differs, before it
   loads any of them. It loads the partition as a replica applies the
   snapshot archive of one partition, and it answers once the
   partition is durable.
6. The controller sets the generation's replicationFactor to the one
   that the request names, or else to the backup's, through the
   replication factor flow.
7. The controller moves the index name onto the generation:
   a. it writes the name's index metadata from the backup's
      configuration and the constraints of step 3 as step 1 of the creation flow writes it, under
      the indexUuid that the job records, using compareAndSet against
      an absent value
   b. it writes the name's allocation table with that indexUuid,
      generation set to the generation's name, and no assignments
   c. it writes the name's schema with putSchema
```

A restored primary numbers its next write one above the partition's `lastSeqNo`, under the term that the generation's allocation table gives it. It replaces its [term history](replication.md#term-history) with that term and a first `seqNo` of 1 where `lastSeqNo` is at least 1, and with an empty history where `lastSeqNo` is 0. The restored segments keep each document's [write record](replication.md#document-write-record) from the source cluster.

The controller must write step 7b before step 7c, because the creation flow allocates a first table for a new schema unless the name's table already carries `generation`.

The controller records a fresh indexUuid for the name in the job before step 7a. Where step 7a fails, the controller refuses with `INDEX_ALREADY_EXISTS`. Any failure before step 7a drops the generation through the [deletion flow](cluster.md#index-deletion-flow), so no index appears. A controller that takes over a running restore finishes steps 7b and 7c where the name's metadata carries the indexUuid that the job records, and it drops the generation otherwise, because a crash can come between step 7a and the controller's next write of the job.

---

## Deleting a Backup

Only the controller deletes a backup, and a node calls the adapter's `delete` for nothing else, so that an operator can withhold the delete permission until they need to delete a backup.

```text
1. The node that receives the request checks the backup name, then
   sends cluster.backup_delete to the controller.
2. The controller refuses the request with BACKUP_NOT_READY where any
   registered node has a specification version below 1.2, with
   BACKUP_NOT_FOUND where the store holds no manifest under the name,
   with BACKUP_IN_PROGRESS while a backup, another deletion, or a
   restore of the same backup runs, and with BACKUP_STORE_CLAIMED as
   The Claim defines. Otherwise it records the job and answers.
3. The controller deletes the manifest.
4. It lists every remaining manifest and every stored file, and it
   deletes each stored file that no remaining manifest lists.
```

Step 4 also removes the files that a failed backup left behind. Where any remaining manifest fails to decode, the controller must delete no stored file and must fail the job with `BACKUP_DAMAGED`, naming that manifest, because it can't tell which files that manifest lists. Running step 4 again deletes nothing more, so a controller that takes over a running deletion repeats steps 3 and 4.

---

## Listing Backups

Any node can list the backups under its cluster's prefix by reading every manifest under `<keyPrefix>/backups/`. A manifest that fails to decode appears in the list with `BACKUP_DAMAGED` in place of its contents.

---

## Jobs

The controller records every backup, restore, and deletion as a job under the coordinator key `_narsil/backups/jobs`, a MessagePack map from job ID to the job, which it writes with compareAndSet:

```text
BackupJob {
  kind:            'backup' or 'restore' or 'delete'
  backupName:      string
  indexName:       string or absent   (absent for a deletion)
  generation:      string or absent   (the generation that a restore creates)
  nameIndexUuid:   string or absent   (the indexUuid that a restore writes in step 7a)
  status:          'running' or 'done' or 'failed'
  partitionsDone:  uint32
  partitionsTotal: uint32
  startedAt:       uint64
  finishedAt:      uint64 or absent
  error:           { code: string, message: string } or absent
}
```

A job ID is a UUID v7. The controller keeps at most 100 finished jobs and removes the oldest one first. The node that received a request reports the job's progress through its task list by reading this key. A controller that takes over fails every running backup, repeats every running deletion, and resumes every running restore as [Restoring a Backup](#restoring-a-backup) defines.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `BACKUP_NOT_FOUND` | The store holds no manifest under the backup name. |
| `BACKUP_ALREADY_EXISTS` | A manifest or a running job already holds the backup name. |
| `BACKUP_DAMAGED` | A manifest fails to decode, or a file that it lists is missing or has another length or SHA-256. A restore that raises it creates no index. |
| `BACKUP_DURABILITY_REQUIRED` | A primary runs without write-ahead log durability. |
| `BACKUP_IN_PROGRESS` | Another job conflicts, as each flow above defines. |
| `BACKUP_STORE_CLAIMED` | Another cluster's UUID is stored under the key prefix. |
| `BACKUP_NOT_READY` | A registered node follows a specification version below 1.2. |
| `BACKUP_STORE_NOT_CONFIGURED` | The node that receives a backup, restore, deletion, or listing request has no backup store configured. |
| `PERSISTENCE_DEPENDENCY_MISSING` | An adapter needs an optional library that the install lacks. |
