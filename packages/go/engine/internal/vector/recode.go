package vector

import (
	"context"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func (f *Field) recodedHead(centroid []float32) (*storeHead, error) {
	store := f.store
	head, err := newStoreHead(store.dimension, store.head.codePresent.length)
	if err != nil {
		return nil, err
	}
	for word := range core.StoreHeaderWords {
		int32Word(head.header.pointer(), word).Store(store.word(word).Load())
	}
	int32Word(head.header.pointer(), core.StoreWordCodeCount).Store(0)
	int32Word(head.header.pointer(), core.StoreWordCalibrated).Store(1)
	int32Word(head.header.pointer(), core.StoreWordCalibrationGeneration).Add(1)
	copy(float32Values(head.centroid.pointer(), store.dimension), centroid)
	return head, nil
}

func (f *Field) recodedTables() (*storeTables, error) {
	store := f.store
	tables := store.tables.clone()
	tables.codeBlocks = nil
	for _, block := range store.tables.codeBlocks {
		copied, err := newStoreBlock(store.codeLayout)
		if err != nil {
			dropBlocks(tables.codeBlocks)
			return nil, err
		}
		if err := copied.memory.growToExactly(block.memory.length); err != nil {
			copied.resource.drop()
			dropBlocks(tables.codeBlocks)
			return nil, err
		}
		tables.codeBlocks = append(tables.codeBlocks, copied)
	}
	return tables, nil
}

func dropBlocks(blocks []*storeBlock) {
	for _, block := range blocks {
		if block != nil {
			block.resource.drop()
		}
	}
}

func (f *Field) recodeEveryVector(ctx context.Context, live *liveVectorMean) error {
	store := f.store
	head, err := f.recodedHead(live.centroid)
	if err != nil {
		return err
	}
	tables, err := f.recodedTables()
	if err != nil {
		head.resource.drop()
		return err
	}
	abandon := func() {
		head.resource.drop()
		dropBlocks(tables.codeBlocks)
	}
	native, err := core.NewStore(store.nativeLayout(head, tables))
	if err != nil {
		abandon()
		return coreFailure("attachStore", err)
	}
	ordinals := make([]int32, 0, recalibrationChunkVectors)
	slots := store.slots()
	err = withWorkspace(func(workspace *core.Workspace) error {
		for ordinal := int32(0); ordinal < slots; ordinal++ {
			if store.holdsCode(ordinal) && store.holdsVector(ordinal) {
				ordinals = append(ordinals, ordinal)
			}
			if len(ordinals) < recalibrationChunkVectors && ordinal+1 < slots {
				continue
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := workspace.Quantise(native, f.config.nativeMetric, ordinals); err != nil {
				return coreFailure("quantise", err)
			}
			ordinals = ordinals[:0]
		}
		return nil
	})
	native.Retire()
	if err != nil {
		abandon()
		return err
	}
	previousHead, previousTables := store.head, store.tables
	store.head, store.tables = head, tables
	if err := f.publish(store, f.graph); err != nil {
		store.head, store.tables = previousHead, previousTables
		abandon()
		return err
	}
	previousHead.resource.drop()
	dropBlocks(previousTables.codeBlocks)
	return nil
}
