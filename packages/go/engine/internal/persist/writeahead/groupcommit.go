package writeahead

import "sync"

type commitBatch struct {
	done chan struct{}
	err  error
}

type groupCommit struct {
	mutex    sync.Mutex
	inFlight bool
	next     *commitBatch
	flush    func() error
}

func (group *groupCommit) commit() error {
	group.mutex.Lock()
	if group.next == nil {
		group.next = &commitBatch{done: make(chan struct{})}
	}
	batch := group.next
	leads := !group.inFlight
	if leads {
		group.inFlight = true
	}
	group.mutex.Unlock()
	if leads {
		group.drainUntil(batch)
	}
	<-batch.done
	return batch.err
}

func (group *groupCommit) drainUntil(own *commitBatch) {
	for {
		group.mutex.Lock()
		current := group.next
		group.next = nil
		if current == nil {
			group.inFlight = false
			group.mutex.Unlock()
			return
		}
		group.mutex.Unlock()
		current.err = group.flush()
		close(current.done)
		if current == own {
			group.mutex.Lock()
			pending := group.next != nil
			if !pending {
				group.inFlight = false
			}
			group.mutex.Unlock()
			if pending {
				go group.drainUntil(nil)
			}
			return
		}
	}
}
