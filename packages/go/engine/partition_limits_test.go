package engine_test

import (
	"context"
	"testing"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	largestPartitionCount = 65_536
	partitionLimitIndex   = "catalogue"
)

func openPartitionLimitEngine(t *testing.T, ctx context.Context) *engine.Narsil {
	t.Helper()
	narsil, err := engine.New(ctx, engine.Config{Workers: engine.WorkerConfig{Enabled: engine.Some(false)}})
	if err != nil {
		t.Fatalf("open the engine: %v", err)
	}
	return narsil
}

func TestPartitionCountsPastTheLimitAreRefused(t *testing.T) {
	ctx := context.Background()
	narsil := openPartitionLimitEngine(t, ctx)
	defer func() { _ = narsil.Shutdown(ctx) }()
	err := narsil.CreateIndex(ctx, partitionLimitIndex, engine.IndexConfig{
		Schema:     engine.Schema{"title": engine.FieldString},
		Partitions: engine.PartitionConfig{MaxPartitions: engine.Some(largestPartitionCount + 1)},
	})
	requireCode(t, err, engine.CodeConfigInvalid, "create with a partition cap past the limit")
	if err := narsil.CreateIndex(ctx, partitionLimitIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString},
	}); err != nil {
		t.Fatalf("create the index: %v", err)
	}
	err = narsil.UpdatePartitionConfig(ctx, partitionLimitIndex,
		engine.PartitionConfig{MaxPartitions: engine.Some(largestPartitionCount + 1)})
	requireCode(t, err, engine.CodeConfigInvalid, "update to a partition cap past the limit")
}

func TestARebalanceRespectsTheDefaultPartitionCap(t *testing.T) {
	ctx := context.Background()
	narsil := openPartitionLimitEngine(t, ctx)
	defer func() { _ = narsil.Shutdown(ctx) }()
	if err := narsil.CreateIndex(ctx, partitionLimitIndex, engine.IndexConfig{
		Schema: engine.Schema{"title": engine.FieldString},
	}); err != nil {
		t.Fatalf("create the index: %v", err)
	}
	requireCode(t, narsil.Rebalance(ctx, partitionLimitIndex, 2), engine.CodePartitionCapacityExceeded,
		"rebalance past the default cap of one partition")
	if err := narsil.Rebalance(ctx, partitionLimitIndex, 1); err != nil {
		t.Fatalf("a rebalance to one partition is refused: %v", err)
	}
	if err := narsil.UpdatePartitionConfig(ctx, partitionLimitIndex,
		engine.PartitionConfig{MaxPartitions: engine.Some(2)}); err != nil {
		t.Fatalf("raise the partition cap: %v", err)
	}
	if err := narsil.Rebalance(ctx, partitionLimitIndex, 2); err != nil {
		t.Fatalf("a rebalance within the raised cap is refused: %v", err)
	}
	stats, err := narsil.GetStats(partitionLimitIndex)
	if err != nil || stats.PartitionCount != 2 {
		t.Fatalf("partition count after the rebalance: %d (%v), want 2", stats.PartitionCount, err)
	}
}
