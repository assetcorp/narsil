package pattern

import "strconv"

const (
	uncachedGeneration = -1
	decidedGeneration  = -2
)

type dfaEdge struct {
	target *dfaState
	steps  int
}

type dfaState struct {
	positions    []uint32
	previousKind int
	generation   int
	denseEdges   []*dfaEdge
	sparseEdges  map[int32]*dfaEdge
	endMatch     int8
}

const (
	endMatchUnknown int8 = iota
	endMatchFalse
	endMatchTrue
)

func (state *dfaState) clearEdges() {
	state.denseEdges = nil
	state.sparseEdges = nil
}

var (
	matchedState = &dfaState{generation: decidedGeneration}
	deadState    = &dfaState{generation: decidedGeneration}
)

func stateKey(positions []uint32, previousKind int) string {
	key := make([]byte, 0, 2+len(positions)*5)
	key = strconv.AppendInt(key, int64(previousKind), 10)
	key = append(key, ':')
	for at, position := range positions {
		if at > 0 {
			key = append(key, ',')
		}
		key = strconv.AppendUint(key, uint64(position), 10)
	}
	return string(key)
}

func stateBytes(positions []uint32, key string) int {
	return matcherStateOverhead + len(positions)*uint32Bytes + len(key)*matcherKeyCharacterBytes
}

type lazyDfa struct {
	program              *program
	states               map[string]*dfaState
	generation           int
	cachedBytes          int
	codePointsSinceReset int
	start                *dfaState
	state                *dfaState
	simulating           bool
	decided              int8
	simulation           *positionSimulation
	cacheLimitBytes      int
	denseClasses         int
}

func newLazyDfa(compiled *program, stateLimitBytes int) *lazyDfa {
	dfa := &lazyDfa{program: compiled, states: map[string]*dfaState{}, simulation: newPositionSimulation(compiled)}
	if classCount := len(compiled.classes.starts) + 1; classCount <= maxDenseEdgeClasses {
		dfa.denseClasses = classCount
	}
	dfa.cacheLimitBytes = stateLimitBytes - compiled.bytes - dfa.simulation.bytes()
	dfa.start = dfa.intern(nil, beforeValueStart)
	dfa.state = dfa.start
	if dfa.wantsSimulation() {
		dfa.simulate(dfa.start)
	}
	return dfa
}

func (dfa *lazyDfa) begin() bool {
	dfa.decided = endMatchUnknown
	dfa.simulating = false
	dfa.state = dfa.start
	if dfa.wantsSimulation() {
		dfa.simulate(dfa.start)
	}
	return true
}

func (dfa *lazyDfa) feed(codePoint rune, tally *workTally) bool {
	if dfa.simulating {
		outcome := dfa.simulation.step(codePoint)
		tally.add(int64(dfa.simulation.steps))
		switch outcome {
		case stepMatched:
			return dfa.decide(true)
		case stepDead:
			return dfa.decide(false)
		}
		return true
	}
	dfa.codePointsSinceReset++
	edge := dfa.edge(dfa.state, codePoint, dfa.program.classOf(codePoint))
	tally.add(int64(edge.steps))
	switch edge.target {
	case matchedState:
		return dfa.decide(true)
	case deadState:
		return dfa.decide(false)
	}
	dfa.state = edge.target
	if dfa.wantsSimulation() {
		dfa.simulate(dfa.state)
	}
	return true
}

func (dfa *lazyDfa) matched() bool {
	if dfa.decided != endMatchUnknown {
		return dfa.decided == endMatchTrue
	}
	if dfa.simulating {
		return dfa.simulation.endMatches()
	}
	state := dfa.state
	if state.endMatch == endMatchUnknown {
		dfa.simulation.load(state.positions, state.previousKind)
		state.endMatch = endMatchFalse
		if dfa.simulation.endMatches() {
			state.endMatch = endMatchTrue
		}
	}
	return state.endMatch == endMatchTrue
}

func (dfa *lazyDfa) decide(outcome bool) bool {
	dfa.decided = endMatchFalse
	if outcome {
		dfa.decided = endMatchTrue
	}
	return false
}

func (dfa *lazyDfa) wantsSimulation() bool {
	return !dfa.simulating && dfa.state.generation == uncachedGeneration
}

func (dfa *lazyDfa) simulate(from *dfaState) {
	dfa.restartCache()
	dfa.state = dfa.start
	dfa.simulation.load(from.positions, from.previousKind)
	dfa.simulating = true
}

func (dfa *lazyDfa) restartCache() {
	for _, state := range dfa.states {
		state.clearEdges()
	}
	dfa.start.clearEdges()
	dfa.state.clearEdges()
	dfa.states = map[string]*dfaState{}
	dfa.cachedBytes = 0
	dfa.codePointsSinceReset = 0
	dfa.generation++
	dfa.start = dfa.intern(dfa.start.positions, dfa.start.previousKind)
}

func (dfa *lazyDfa) edge(state *dfaState, codePoint rune, codePointClass int32) *dfaEdge {
	current := state.generation == dfa.generation
	dense := codePointClass >= 0 && int(codePointClass) < dfa.denseClasses
	if current {
		if dense && state.denseEdges != nil && state.denseEdges[codePointClass] != nil {
			return state.denseEdges[codePointClass]
		}
		if !dense && state.sparseEdges != nil {
			if cached, held := state.sparseEdges[codePointClass]; held {
				return cached
			}
		}
	}
	simulation := dfa.simulation
	simulation.load(state.positions, state.previousKind)
	outcome := simulation.step(codePoint)
	edge := &dfaEdge{target: matchedState, steps: simulation.steps}
	switch outcome {
	case stepDead:
		edge.target = deadState
	case stepContinues:
		edge.target = dfa.intern(simulation.sortedAfter(), simulation.previousKind)
	}
	targetCached := edge.target.generation == decidedGeneration || edge.target.generation == dfa.generation
	if !current || state.generation != dfa.generation || !targetCached {
		return edge
	}
	if !dfa.reserve(matcherTransitionBytes) || state.generation != dfa.generation {
		return edge
	}
	if !dense {
		if state.sparseEdges == nil {
			state.sparseEdges = map[int32]*dfaEdge{}
		}
		state.sparseEdges[codePointClass] = edge
		return edge
	}
	if state.denseEdges == nil {
		if !dfa.reserve(dfa.denseClasses*matcherEdgeSlotBytes) || state.generation != dfa.generation {
			return edge
		}
		state.denseEdges = make([]*dfaEdge, dfa.denseClasses)
	}
	state.denseEdges[codePointClass] = edge
	return edge
}

func (dfa *lazyDfa) intern(positions []uint32, previousKind int) *dfaState {
	key := stateKey(positions, previousKind)
	if existing, held := dfa.states[key]; held {
		return existing
	}
	if !dfa.reserve(stateBytes(positions, key)) {
		return &dfaState{positions: positions, previousKind: previousKind, generation: uncachedGeneration}
	}
	state := &dfaState{positions: positions, previousKind: previousKind, generation: dfa.generation}
	dfa.states[key] = state
	return state
}

func (dfa *lazyDfa) reserve(bytes int) bool {
	for {
		if dfa.cachedBytes+bytes <= dfa.cacheLimitBytes {
			dfa.cachedBytes += bytes
			return true
		}
		if len(dfa.states) == 0 || dfa.codePointsSinceReset < minCodePointsPerState*len(dfa.states) {
			return false
		}
		dfa.restartCache()
		if dfa.start.generation == uncachedGeneration {
			return false
		}
	}
}
