package vector

import "context"

func (c *coldGraphField) partitionTable(ctx context.Context) ([]int32, error) {
	if table := c.partitions.Load(); table != nil {
		return *table, nil
	}
	built := make([]int32, c.total)
	for number := range c.total {
		built[number] = noPartition
		if c.isDeadNumber(number) {
			continue
		}
		id, err := c.idAt(number)
		if err != nil {
			return nil, err
		}
		partition, known, err := c.PartitionOf(ctx, id)
		if err != nil {
			return nil, err
		}
		if known {
			built[number] = partition
		}
	}
	if c.closed.Load() {
		return built, nil
	}
	if !c.partitions.CompareAndSwap(nil, &built) {
		if published := c.partitions.Load(); published != nil {
			return *published, nil
		}
		return built, nil
	}
	if c.closed.Load() {
		c.partitions.Store(nil)
	}
	return built, nil
}

func (c *coldGraphField) numbersInPartitions(ctx context.Context, filter *Filter) ([]uint32, error) {
	table, err := c.partitionTable(ctx)
	if err != nil {
		return nil, err
	}
	return bitsetWith(c.total, func(set func(number int)) {
		for number, partition := range table {
			if _, wanted := filter.partitions[partition]; wanted && partition != noPartition {
				set(number)
			}
		}
	}), nil
}
