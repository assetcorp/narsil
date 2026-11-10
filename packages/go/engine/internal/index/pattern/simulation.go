package pattern

import "slices"

const (
	stepContinues = 0
	stepMatched   = 1
	stepDead      = 2
)

type startClosure struct {
	positions []uint32
	matches   bool
}

func simulationBytes(states, positions int) int {
	startClosureBytes := simulationContexts * uint32Bytes
	return states*simulationStateBytes + positions*(simulationPositionBytes+startClosureBytes)
}

type positionSimulation struct {
	program      *program
	steps        int
	previousKind int
	after        []uint32
	afterCount   int
	candidates   []uint32
	scratch      *closureScratch
	starts       [simulationContexts]*startClosure
}

func newPositionSimulation(compiled *program) *positionSimulation {
	return &positionSimulation{
		program:    compiled,
		after:      make([]uint32, compiled.positions),
		candidates: make([]uint32, compiled.positions),
		scratch:    newClosureScratch(compiled.states),
	}
}

func (simulation *positionSimulation) bytes() int {
	return simulationBytes(simulation.program.states, simulation.program.positions)
}

func (simulation *positionSimulation) load(positions []uint32, previousKind int) {
	copy(simulation.after, positions)
	simulation.afterCount = len(positions)
	simulation.previousKind = previousKind
}

func (simulation *positionSimulation) sortedAfter() []uint32 {
	sorted := slices.Clone(simulation.after[:simulation.afterCount])
	slices.Sort(sorted)
	return sorted
}

func (simulation *positionSimulation) step(codePoint rune) int {
	compiled, candidates := simulation.program, simulation.candidates
	following := kindOf(codePoint)
	reached := simulation.close(contextOf(simulation.previousKind, following))
	if reached == matchReached {
		simulation.steps = 0
		return stepMatched
	}
	simulation.steps = reached
	kept := 0
	for _, position := range candidates[:reached] {
		if compiled.accepts(position, codePoint) {
			simulation.after[kept] = position
			kept++
		}
	}
	simulation.afterCount = kept
	simulation.previousKind = following
	if kept == 0 && compiled.anchoredStart {
		return stepDead
	}
	return stepContinues
}

func (simulation *positionSimulation) endMatches() bool {
	return simulation.close(contextOf(simulation.previousKind, afterValueEnd)) == matchReached
}

func (simulation *positionSimulation) startClosure(context int) *startClosure {
	if known := simulation.starts[context]; known != nil {
		return known
	}
	reached := simulation.program.closeOver(nil, true, context, simulation.scratch, simulation.candidates)
	closure := &startClosure{matches: true}
	if reached != matchReached {
		closure = &startClosure{positions: slices.Clone(simulation.candidates[:reached])}
	}
	simulation.starts[context] = closure
	return closure
}

func (simulation *positionSimulation) close(context int) int {
	compiled := simulation.program
	fromStart := simulation.previousKind == beforeValueStart || !compiled.anchoredStart
	var start *startClosure
	if fromStart {
		start = simulation.startClosure(context)
		if start.matches {
			return matchReached
		}
	}
	scratch, candidates := simulation.scratch, simulation.candidates
	count := compiled.closeOver(simulation.after[:simulation.afterCount], false, context, scratch, candidates)
	if count == matchReached || start == nil {
		return count
	}
	marks, stamp := scratch.marks, scratch.stamp
	for _, position := range start.positions {
		if marks[position] == stamp {
			continue
		}
		marks[position] = stamp
		candidates[count] = position
		count++
	}
	return count
}
