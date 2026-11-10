package persist

import "context"

func (durable *Durable) PersistMetadata(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	durable.metadataMutex.Lock()
	defer durable.metadataMutex.Unlock()
	meta, err := durable.handle.metadata(uint64(durable.handle.Index.Count()))
	if err != nil {
		return err
	}
	return durable.storeMetadata(ctx, meta)
}
