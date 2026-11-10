package partition

import (
	"runtime"
	"sync"
	"sync/atomic"
)

func (p *Partition) eachDocument(count int, work func(index int)) {
	workers := min(runtime.GOMAXPROCS(0), count/parallelAnalysisDocumentsPerWorker)
	if workers <= 1 || p.settings.Analyzer.HasCustomTokenizer() {
		for index := range count {
			work(index)
		}
		return
	}
	var next atomic.Int64
	var group sync.WaitGroup
	for range workers {
		group.Go(func() {
			for {
				index := int(next.Add(1) - 1)
				if index >= count {
					return
				}
				work(index)
			}
		})
	}
	group.Wait()
}
