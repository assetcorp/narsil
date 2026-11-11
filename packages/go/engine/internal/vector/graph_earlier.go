package vector

import "slices"

func (f *Field) earlierGraphsInUse() []*graphMemory {
	inUse := f.earlier[:0]
	for _, graph := range f.earlier {
		if !graph.resource.released() {
			inUse = append(inUse, graph)
		}
	}
	clear(f.earlier[len(inUse):])
	f.earlier = inUse
	return inUse
}

func (f *Field) rememberReplacedGraph(replaced *graphMemory) {
	f.earlier = append(f.earlierGraphsInUse(), replaced)
}

func (f *Field) scanOnEarlierGraphs(leavingBuffer []int32) {
	if len(leavingBuffer) == 0 {
		return
	}
	for _, graph := range f.earlierGraphsInUse() {
		listed := leavingBuffer
		if before := graph.alsoScan.Load(); before != nil {
			listed = slices.Concat(*before, leavingBuffer)
		}
		graph.alsoScan.Store(&listed)
	}
}
