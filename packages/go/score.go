package narsil

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

func encodeHitScore(score *float64) any {
	if score == nil {
		return nil
	}
	switch {
	case math.IsNaN(*score):
		return "NaN"
	case math.IsInf(*score, 1):
		return "Infinity"
	case math.IsInf(*score, -1):
		return "-Infinity"
	default:
		return *score
	}
}

func decodeHitScore(data json.RawMessage) (*float64, error) {
	if len(data) == 0 {
		return nil, nil
	}
	data = bytes.TrimSpace(data)
	var score float64
	if len(data) > 0 && data[0] == '"' {
		var token string
		if err := json.Unmarshal(data, &token); err != nil {
			return nil, err
		}
		switch token {
		case "NaN":
			score = math.NaN()
		case "Infinity":
			score = math.Inf(1)
		case "-Infinity":
			score = math.Inf(-1)
		default:
			return nil, fmt.Errorf("narsil: invalid hit score token %q", token)
		}
	} else {
		if bytes.Equal(data, []byte("null")) {
			return nil, fmt.Errorf("narsil: a present hit score cannot be null")
		}
		if err := json.Unmarshal(data, &score); err != nil {
			return nil, err
		}
	}
	return &score, nil
}
