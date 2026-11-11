package index

import "runtime"

type textLegResult struct {
	found    fanOutResult
	err      error
	panicked any
}

var spareLegGoroutines = newLegTokens(runtime.GOMAXPROCS(0) - 1)

func newLegTokens(count int) chan struct{} {
	tokens := make(chan struct{}, max(0, count))
	for range cap(tokens) {
		tokens <- struct{}{}
	}
	return tokens
}

func claimSpareLegGoroutine() bool {
	select {
	case <-spareLegGoroutines:
		return true
	default:
		return false
	}
}

func bothLegs(vectorLeg func() (VectorOutcome, error), textLeg func() (fanOutResult, error)) (VectorOutcome, fanOutResult, error) {
	if !claimSpareLegGoroutine() {
		outcome, err := vectorLeg()
		if err != nil {
			return VectorOutcome{}, fanOutResult{}, err
		}
		found, err := textLeg()
		return outcome, found, err
	}
	finished := make(chan textLegResult, 1)
	go func() {
		var result textLegResult
		defer func() {
			result.panicked = recover()
			spareLegGoroutines <- struct{}{}
			finished <- result
		}()
		result.found, result.err = textLeg()
	}()
	outcome, vectorErr := vectorLeg()
	text := <-finished
	if vectorErr != nil {
		return VectorOutcome{}, fanOutResult{}, vectorErr
	}
	if text.panicked != nil {
		panic(text.panicked)
	}
	return outcome, text.found, text.err
}
