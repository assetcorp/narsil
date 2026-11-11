package engine

import (
	"context"
	"fmt"
	"runtime"
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type queryTask struct {
	run  func() error
	done chan error
}

type queryPool struct {
	enabled   bool
	count     int
	threshold int
	lone      bool
	events    *eventBus

	mu      sync.Mutex
	started bool
	closed  bool
	tasks   chan queryTask
	stop    chan struct{}
	group   sync.WaitGroup
}

func resolveWorkerCount(requested int) int {
	if requested > 0 {
		return min(requested, maxRequestedWorkerCount)
	}
	return max(minWorkerCount, min(maxWorkerCount, runtime.NumCPU()-1))
}

func newQueryPool(config model.WorkerConfig, events *eventBus) (*queryPool, error) {
	if count, set := config.Count.Get(); set && count < 0 {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "workers.count must be a positive integer", map[string]any{"count": count})
	}
	threshold := config.PromotionThreshold.Or(defaultPromotionThreshold)
	if threshold < 1 {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "workers.promotionThreshold must be a positive integer",
			map[string]any{"promotionThreshold": threshold})
	}
	mode := config.MainCopyQueries
	if mode != "" && mode != model.MainCopyQueriesLone && mode != model.MainCopyQueriesNone {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "workers.mainCopyQueries must be 'lone' or 'none'",
			map[string]any{"mainCopyQueries": string(mode)})
	}
	return &queryPool{
		enabled:   config.Enabled.Or(true),
		count:     resolveWorkerCount(config.Count.Or(0)),
		threshold: threshold,
		lone:      mode != model.MainCopyQueriesNone,
		events:    events,
		stop:      make(chan struct{}),
	}, nil
}

func (pool *queryPool) start() bool {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.closed || pool.started {
		return false
	}
	pool.started = true
	pool.tasks = make(chan queryTask)
	for worker := range pool.count {
		pool.group.Add(1)
		go pool.serve(worker)
	}
	return true
}

func (pool *queryPool) serve(worker int) {
	defer pool.group.Done()
	for {
		select {
		case <-pool.stop:
			return
		case task := <-pool.tasks:
			task.done <- pool.execute(worker, task.run)
		}
	}
}

func (pool *queryPool) execute(worker int, run func() error) (err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		err = narsilerr.New(narsilerr.CodeWorkerCrashed, fmt.Sprintf("Query worker %d stopped: %v", worker, recovered),
			map[string]any{"workerId": worker})
		pool.events.emit(model.WorkerCrashEvent{WorkerID: worker, Err: err})
	}()
	return run()
}

func (pool *queryPool) consider(entry *indexEntry) {
	if !pool.enabled || entry.promoted.Load() {
		return
	}
	held := entry.index().Count()
	if held < pool.threshold {
		return
	}
	if !entry.promoted.CompareAndSwap(false, true) {
		return
	}
	pool.start()
	pool.events.emit(model.WorkerPromoteEvent{WorkerCount: pool.count,
		Reason: fmt.Sprintf("Index %q holds %d documents, reaching the copy threshold of %d", entry.name, held, pool.threshold)})
}

func (pool *queryPool) forget(string) {}

func (pool *queryPool) run(ctx context.Context, entry *indexEntry, run func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	pool.mu.Lock()
	tasks, serving := pool.tasks, pool.started && !pool.closed
	pool.mu.Unlock()
	if !serving || !entry.promoted.Load() {
		return run()
	}
	task := queryTask{run: run, done: make(chan error, 1)}
	if pool.lone {
		select {
		case tasks <- task:
			return pool.await(task)
		case <-pool.stop:
			return run()
		default:
			return run()
		}
	}
	select {
	case tasks <- task:
		return pool.await(task)
	case <-pool.stop:
		return run()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (pool *queryPool) await(task queryTask) error {
	return <-task.done
}

func (pool *queryPool) close() {
	pool.mu.Lock()
	if pool.closed {
		pool.mu.Unlock()
		return
	}
	pool.closed = true
	close(pool.stop)
	pool.mu.Unlock()
	pool.group.Wait()
}

func (pool *queryPool) memoryReports() []model.WorkerMemoryReport {
	pool.mu.Lock()
	serving := pool.started && !pool.closed
	pool.mu.Unlock()
	if !serving {
		return []model.WorkerMemoryReport{}
	}
	reports := make([]model.WorkerMemoryReport, 0, pool.count)
	for worker := range pool.count {
		reports = append(reports, model.WorkerMemoryReport{WorkerID: worker})
	}
	return reports
}
