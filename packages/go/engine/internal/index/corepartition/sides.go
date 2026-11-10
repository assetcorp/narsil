package corepartition

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

type Sides struct {
	slots      *vector.Slots
	partitions []*Partition
}

func NewSides(slots *vector.Slots) *Sides {
	return &Sides{slots: slots}
}

func (s *Sides) Slots() *vector.Slots {
	return s.slots
}

func (s *Sides) Add(partition *Partition) {
	s.partitions = append(s.partitions, partition)
}

func (s *Sides) Remove(partition *Partition) {
	for at, held := range s.partitions {
		if held == partition {
			s.partitions = append(s.partitions[:at:at], s.partitions[at+1:]...)
			return
		}
	}
}

type Write struct {
	Workspace *core.Workspace
	Sequence  int64
	side      int
}

func sideOf(sequence int64) int {
	return int(sequence & 1)
}

func (s *Sides) Write(apply func(write *Write) error) error {
	return s.slots.Write(func(sequence int64) error {
		s.slots.WaitForPinsFrom(sequence - 1)
		w, err := core.AcquireWorkspace()
		if err != nil {
			return err
		}
		defer w.Release()
		write := &Write{Workspace: w, Sequence: sequence, side: sideOf(sequence)}
		for _, partition := range s.partitions {
			if err := partition.catchUp(write); err != nil {
				return err
			}
		}
		return apply(write)
	})
}

type Read struct {
	lease *vector.Lease
	side  int
}

func (s *Sides) Read() (*Read, error) {
	lease, err := s.slots.AcquireSearch()
	if err != nil {
		return nil, err
	}
	return &Read{lease: lease, side: sideOf(lease.Pin())}, nil
}

func (r *Read) Lease() *vector.Lease {
	return r.lease
}

func (r *Read) Release() {
	r.lease.Release()
}
