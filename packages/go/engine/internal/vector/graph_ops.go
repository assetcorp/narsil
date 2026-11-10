package vector

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func (f *Field) withGraphAlone(graph *graphMemory, operation func(held *graphMemory) error) (*graphMemory, error) {
	published := graph == f.graph
	target := graph
	if published {
		copied, err := graph.clone()
		if err != nil {
			return graph, err
		}
		target = copied
	}
	if !target.holdAlone() {
		if published {
			target.resource.drop()
		}
		return graph, coreFailure("holdGraph", &core.StatusError{Operation: "holdGraph", Status: core.StatusGraphNotHeldAlone})
	}
	err := operation(target)
	target.releaseHold()
	if !published {
		return target, err
	}
	if err != nil {
		target.resource.drop()
		return graph, err
	}
	f.graph = target
	if publishErr := f.publish(f.store, target); publishErr != nil {
		f.graph = graph
		target.resource.drop()
		return graph, publishErr
	}
	f.rememberReplacedGraph(graph)
	graph.resource.drop()
	return target, nil
}

func (f *Field) writerSlotOn(graph *graphMemory) uint32 {
	f.writer.enter(graph)
	return f.writer.slot
}

func (f *Field) connectHeld(held *graphMemory, nearby []int32) error {
	return withWorkspace(func(workspace *core.Workspace) error {
		slot := f.writerSlotOn(held)
		defer f.writer.leave()
		err := workspace.ConnectUnreached(held.native, f.nativeStore(), f.config.nativeMetric, slot, nearby)
		if err != nil {
			return coreFailure("connectUnreached", err)
		}
		held.word(core.GraphWordUnlinkedNodes).Store(0)
		return nil
	})
}

func (f *Field) connectUnreached(graph *graphMemory) (*graphMemory, error) {
	if graph == f.graph && !graph.needsConnecting() {
		graph.word(core.GraphWordUnlinkedNodes).Store(0)
		return graph, nil
	}
	return f.withGraphAlone(graph, func(held *graphMemory) error { return f.connectHeld(held, nil) })
}

func (f *Field) connectAfterPlacement(graph *graphMemory) (*graphMemory, error) {
	if !graph.holdsUnlinkedNode() {
		return graph, nil
	}
	return f.connectUnreached(graph)
}

func (f *Field) countIncomingBeforeWriting(graph *graphMemory, connectsAfterwards bool) (*graphMemory, error) {
	if graph.word(graphWordIncomingUncounted).Load() == 0 {
		return graph, nil
	}
	return f.withGraphAlone(graph, func(held *graphMemory) error {
		held.recountIncoming()
		unlinked := held.holdsUnreachedLiveNode()
		if unlinked && !connectsAfterwards {
			if err := f.connectHeld(held, nil); err != nil {
				return err
			}
		}
		if unlinked && connectsAfterwards {
			held.word(core.GraphWordUnlinkedNodes).Store(1)
		} else {
			held.word(core.GraphWordUnlinkedNodes).Store(0)
		}
		held.word(graphWordIncomingUncounted).Store(0)
		return nil
	})
}

func (f *Field) placeThroughTheCore(graph *graphMemory, ordinal int32) error {
	level := levelOfOrdinal(ordinal, graph.multiplier)
	return withWorkspace(func(workspace *core.Workspace) error {
		slot := f.writerSlotOn(graph)
		defer f.writer.leave()
		for range placementRoomRequests {
			if err := graph.ensureUpperRoom(level); err != nil {
				return err
			}
			err := workspace.Place(graph.native, f.nativeStore(), core.PlaceRequest{
				Metric: f.config.nativeMetric, Ordinal: ordinal, TopLayer: level, ThreadSlot: slot,
			})
			if err == nil {
				return nil
			}
			if core.StatusOf(err) != core.StatusNeedsRoom {
				return coreFailure("place", err)
			}
			if err := graph.ensureCapacity(int(ordinal) + 1); err != nil {
				return err
			}
			graph.publishCapacity()
		}
		return coreFailure("place", &core.StatusError{Operation: "place", Status: core.StatusNeedsRoom})
	})
}

func (f *Field) insertOrdinal(graph *graphMemory, ordinal int32, connectsAfterwards bool) (*graphMemory, bool, error) {
	if !f.store.holdsDocument(ordinal) {
		return graph, false, nil
	}
	if err := graph.ensureCapacity(int(ordinal) + 1); err != nil {
		return graph, false, err
	}
	if graph.holdsNode(ordinal) {
		return graph, false, nil
	}
	graph, err := f.countIncomingBeforeWriting(graph, connectsAfterwards)
	if err != nil {
		return graph, false, err
	}
	if f.calibrated() {
		if err := f.writeCodesOf([]int32{ordinal}); err != nil {
			return graph, false, err
		}
	}
	if err := f.placeThroughTheCore(graph, ordinal); err != nil {
		return graph, false, err
	}
	if connectsAfterwards {
		return graph, true, nil
	}
	graph, err = f.connectAfterPlacement(graph)
	return graph, err == nil, err
}

func (f *Field) markTombstoneOrdinal(graph *graphMemory, ordinal int32) error {
	if graph == nil || !graph.holdsNode(ordinal) || uintptr(ordinal) >= graph.tombstones.length {
		return nil
	}
	slot := f.writerSlotOn(graph)
	defer f.writer.leave()
	if err := core.RemoveNode(graph.native, ordinal, slot); err != nil {
		return coreFailure("remove", err)
	}
	return nil
}

func (f *Field) baseNeighboursOfRemoved(graph *graphMemory, removed []int32) []int32 {
	leaving := make(map[int32]struct{}, len(removed))
	for _, ordinal := range removed {
		leaving[ordinal] = struct{}{}
	}
	nearby := []int32{}
	for _, ordinal := range removed {
		for _, neighbour := range graph.baseList(ordinal) {
			if _, gone := leaving[neighbour]; !gone {
				nearby = append(nearby, neighbour)
			}
		}
	}
	return nearby
}

func (f *Field) compactGraph(graph *graphMemory) (*graphMemory, error) {
	if graph.tombstoneCount() == 0 {
		return graph, nil
	}
	return f.withGraphAlone(graph, func(held *graphMemory) error {
		if held.word(graphWordIncomingUncounted).Load() != 0 {
			held.recountIncoming()
			if held.holdsUnreachedLiveNode() {
				if err := f.connectHeld(held, nil); err != nil {
					return err
				}
			}
			held.word(core.GraphWordUnlinkedNodes).Store(0)
			held.word(graphWordIncomingUncounted).Store(0)
		}
		removed := []int32{}
		for ordinal := range held.slots() {
			if held.tombstoned(ordinal) && held.holdsNode(ordinal) {
				removed = append(removed, ordinal)
			}
		}
		nearby := f.baseNeighboursOfRemoved(held, removed)
		err := withWorkspace(func(workspace *core.Workspace) error {
			current := f.writerLayout()
			native, err := core.NewStore(f.store.nativeLayout(current.head, current.tables))
			if err != nil {
				return coreFailure("attachStore", err)
			}
			defer native.Retire()
			slot := f.writerSlotOn(held)
			defer f.writer.leave()
			if err := workspace.Compact(held.native, native, f.config.nativeMetric, slot); err != nil {
				return coreFailure("compact", err)
			}
			return nil
		})
		if err != nil {
			return err
		}
		return f.connectHeld(held, nearby)
	})
}
