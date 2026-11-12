// Package changes follows every insert, update, and removal on a Narsil index over the server's change
// feed, a WebSocket that the server serves while its changes option is on and the index has change
// capture on.
//
// Turn capture on with the client's UpdateChanges, then follow the index from an export or from the
// present:
//
//	subscription, err := changes.Follow(ctx, client, "products", changes.Options{
//		Epoch: saved.Epoch, Positions: saved.Positions, Credential: token,
//	})
//	if err != nil {
//		return err
//	}
//	for event, err := range subscription.All() {
//		if err != nil {
//			return err
//		}
//		if batch, ok := event.(*changes.Batch); ok {
//			apply(batch.Changes)
//			save(batch.PartitionID, batch.ScannedSeqNo)
//			if err := subscription.Ack([]changes.Position{{PartitionID: batch.PartitionID, SeqNo: batch.ScannedSeqNo}}); err != nil {
//				return err
//			}
//		}
//	}
//
// The server delivers each change at least once, so apply a change in a way that leaves the same result
// when it arrives twice, and count a removal of a document that you lack as a success. After a
// disconnection, follow again with the saved epoch and positions. After a *Resync, take a document
// export of the index, replace your copy with its documents, and follow from the epoch and the
// positions in its header.
//
// The module keeps the client module free of dependencies, and it depends on the client and on
// github.com/coder/websocket.
package changes
