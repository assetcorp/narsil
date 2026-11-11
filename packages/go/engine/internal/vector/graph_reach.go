package vector

func (g *graphMemory) holdsNearestLinkDue() bool {
	slots := min(uintptr(max(0, g.slots())), g.nearestLinkDue.length)
	for ordinal := range int(slots) {
		if loadByte(g.nearestLinkDue.pointer(), ordinal) == 1 {
			return true
		}
	}
	return false
}

func (g *graphMemory) holdsLiveNodeOutsideTheWalk() bool {
	entry := g.entryPoint()
	if g.nodeLevel(entry) < 0 {
		return false
	}
	slots := int(max(0, g.slots()))
	reached := make([]bool, slots)
	queue := make([]int32, 0, min(slots, initialReachQueue))
	if int(entry) >= slots {
		return true
	}
	reached[entry] = true
	queue = append(queue, entry)
	for head := 0; head < len(queue); head++ {
		for _, next := range g.baseList(queue[head]) {
			if next < 0 || int(next) >= slots || reached[next] || g.nodeLevel(next) < 0 {
				continue
			}
			reached[next] = true
			queue = append(queue, next)
		}
	}
	for ordinal := range int32(slots) {
		if !reached[ordinal] && g.holdsLiveNode(ordinal) {
			return true
		}
	}
	return false
}

func (g *graphMemory) needsConnecting() bool {
	return g.holdsNearestLinkDue() || g.holdsLiveNodeOutsideTheWalk()
}
