package pattern

type preparedExpression struct {
	plan *plan
	runs runQuery
}

func parsedWithinLimits(label expressionLabel, source string, caseFold bool) (*node, error) {
	codePoints := codePointsOf(source)
	var parsed *node
	var failure *parseFailure
	if label.operator == OperatorRegex {
		parsed, failure = parseRegex(codePoints)
	} else {
		parsed, failure = parseWildcard(codePoints)
	}
	if failure != nil {
		return nil, label.refusal(failure.reason, failure.at)
	}
	if patternPositions(parsed, caseFold) > MaxPositions {
		return nil, label.tooManyPositions(caseFold)
	}
	return parsed, nil
}

func CheckExpression(operator Operator, source string, caseFold bool, fieldPath string) error {
	_, err := parsedWithinLimits(expressionLabel{operator: operator, fieldPath: fieldPath, hasFieldPath: true}, source, caseFold)
	return err
}

func prepareExpression(operator Operator, source string, caseFold bool) (*preparedExpression, error) {
	parsed, err := parsedWithinLimits(expressionLabel{operator: operator}, source, caseFold)
	if err != nil {
		return nil, err
	}
	return &preparedExpression{plan: lowerPattern(parsed, caseFold), runs: requiredRuns(parsed)}, nil
}

func footprintOf(bytes, states, positions int) int {
	return bytes + simulationBytes(states, positions) + matcherStateOverhead + positions*uint32Bytes
}

func ExpressionFootprint(operator Operator, source string, caseFold bool) (int, error) {
	prepared, err := prepareExpression(operator, source, caseFold)
	if err != nil {
		return 0, err
	}
	size := planSize(prepared.plan)
	return footprintOf(size.bytes, size.states, size.positions), nil
}

func WidestSplit(footprintBytes int) int {
	return max(1, MatcherStateBudgetBytes/max(1, footprintBytes))
}
