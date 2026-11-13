package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine"
)

const (
	memoryReadyLine    = "memory-ready"
	memoryMeasuredLine = "memory-measured"
)

type verifiedAnswer struct {
	Count      int     `json:"count"`
	CountExact bool    `json:"countExact"`
	Hits       [][]any `json:"hits"`
}

type measuredPhase struct {
	Queries      int     `json:"queries"`
	WarmupPasses int     `json:"warmupPasses"`
	Passes       int     `json:"passes"`
	Threads      int     `json:"threads"`
	WallNs       int64   `json:"wallNs"`
	LatencyNs    []int64 `json:"latencyNs"`
	Mismatches   int64   `json:"mismatches"`
}

type search func(query int) (engine.QueryResult, error)

func verified(result engine.QueryResult) (verifiedAnswer, error) {
	hits := make([][]any, len(result.Hits))
	for index, hit := range result.Hits {
		score, present := hit.Score.Get()
		if !present {
			return verifiedAnswer{}, fmt.Errorf("hit %s carries no score", hit.ID)
		}
		hits[index] = []any{hit.ID, score}
	}
	answer := verifiedAnswer{Count: result.Count, CountExact: result.CountExact, Hits: hits}
	return answer, nil
}

func sameAnswer(result engine.QueryResult, expected verifiedAnswer) bool {
	if result.Count != expected.Count || result.CountExact != expected.CountExact || len(result.Hits) != len(expected.Hits) {
		return false
	}
	for rank, hit := range result.Hits {
		score, present := hit.Score.Get()
		if !present || hit.ID != expected.Hits[rank][0] || score != expected.Hits[rank][1] {
			return false
		}
	}
	return true
}

func inParallel(threads int, items int, work func(item int) error) error {
	var next atomic.Int64
	var stopped atomic.Bool
	var failure error
	var once sync.Once
	var group sync.WaitGroup
	for range threads {
		group.Go(func() {
			for !stopped.Load() {
				item := int(next.Add(1) - 1)
				if item >= items {
					return
				}
				if err := work(item); err != nil {
					stopped.Store(true)
					once.Do(func() { failure = err })
					return
				}
			}
		})
	}
	group.Wait()
	return failure
}

func verifyEach(queries int, run search) ([]verifiedAnswer, error) {
	answers := make([]verifiedAnswer, queries)
	for query := range queries {
		result, err := run(query)
		if err != nil {
			return nil, err
		}
		if answers[query], err = verified(result); err != nil {
			return nil, err
		}
	}
	return answers, nil
}

func measurePhase(threads, warmupPasses, passes int, expected []verifiedAnswer, run search) (measuredPhase, error) {
	queries := len(expected)
	err := inParallel(threads, warmupPasses*queries, func(item int) error {
		_, err := run(item % queries)
		return err
	})
	if err != nil {
		return measuredPhase{}, err
	}
	total := passes * queries
	latencies := make([]int64, total)
	var mismatches atomic.Int64
	start := time.Now()
	err = inParallel(threads, total, func(item int) error {
		query := item % queries
		began := time.Now()
		result, err := run(query)
		latencies[item] = time.Since(began).Nanoseconds()
		if err != nil {
			return err
		}
		if !sameAnswer(result, expected[query]) {
			mismatches.Add(1)
		}
		return nil
	})
	wall := time.Since(start).Nanoseconds()
	if err != nil {
		return measuredPhase{}, err
	}
	return measuredPhase{
		Queries:      queries,
		WarmupPasses: warmupPasses,
		Passes:       passes,
		Threads:      threads,
		WallNs:       wall,
		LatencyNs:    latencies,
		Mismatches:   mismatches.Load(),
	}, nil
}

func holdForMemoryReading() error {
	if _, err := fmt.Fprintln(os.Stdout, memoryReadyLine); err != nil {
		return err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return errors.New("the driver closed stdin before it measured memory")
	}
	if strings.TrimSpace(line) != memoryMeasuredLine {
		return fmt.Errorf("the driver answered %q where the runner waits for %s", line, memoryMeasuredLine)
	}
	return nil
}
