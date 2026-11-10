package fields

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type SortColumns struct {
	limits    Limits
	columns   map[string]*SortColumn
	keys      []string
	live      array[uint32]
	liveCount uint64
}

func NewSortColumns(limits Limits, capacity uint32, liveOrdinals []uint32) (*SortColumns, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	if capacity > limits.MaxOrdinals {
		return nil, limits.checkOrdinal(capacity)
	}
	set := &SortColumns{
		limits:  limits,
		columns: map[string]*SortColumn{},
		live:    newArray[uint32]("sort live bitset", bitsetWords(limits.MaxOrdinals)),
	}
	if err := set.live.reserveExactly(bitsetWords(capacity)); err != nil {
		return nil, err
	}
	bits := set.live.all()
	for _, ordinal := range liveOrdinals {
		if !hasBit(bits, ordinal) && uint64(ordinal>>wordShift) < uint64(len(bits)) {
			setBit(bits, ordinal)
			set.liveCount++
		}
	}
	return set, nil
}

func SortColumnKey(field string, listCapable bool, mode core.SortMode) string {
	if !listCapable {
		return "value:" + field
	}
	return strconv.FormatUint(uint64(mode), 10) + ":" + field
}

func (s *SortColumns) liveBitset(capacity uint64) []uint32 {
	words := bitsetWords(uint32(capacity))
	live := make([]uint32, words)
	copy(live, s.live.all())
	return live
}

func checkSortMode(field string, mode core.SortMode) error {
	if mode > core.SortMedian {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "a sort column takes the min, max, avg, or median mode",
			map[string]any{"field": field, "mode": float64(mode)})
	}
	return nil
}

func (s *SortColumns) Ensure(field string, listCapable bool, mode core.SortMode, stored *Stored, capacity uint32) (*SortColumn, error) {
	if err := checkSortMode(field, mode); err != nil {
		return nil, err
	}
	key := SortColumnKey(field, listCapable, mode)
	if held, found := s.columns[key]; found {
		return held, nil
	}
	if stored == nil || stored.path != field {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "a sort column reads the stored values of its own field",
			map[string]any{"field": field})
	}
	column, err := BuildSortColumn(field, mode, stored, s.limits, capacity, s.liveBitset(uint64(capacity)))
	if err != nil {
		return nil, err
	}
	s.columns[key] = column
	s.keys = append(s.keys, key)
	return column, nil
}

func BuildSortColumn(field string, mode core.SortMode, stored StoredSource, limits Limits, capacity uint32,
	live []uint32) (*SortColumn, error) {
	if err := checkSortMode(field, mode); err != nil {
		return nil, err
	}
	if capacity > limits.MaxOrdinals {
		return nil, limits.checkOrdinal(capacity)
	}
	words := bitsetWords(capacity)
	if uint64(len(live)) < words {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, "a sort column needs a live bitset that covers its ordinals",
			map[string]any{"field": field})
	}
	live = live[:words]
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return nil, coreFailure("workspaceCreate", err)
	}
	defer workspace.Release()
	column := newSortColumn(field, mode, stored, limits)
	failed := func(err error) (*SortColumn, error) {
		column.Release()
		return nil, err
	}
	var recordErr error
	forEachBit(live, func(ordinal uint32) {
		if recordErr == nil && ordinal < capacity {
			value, err := column.reduce(workspace, ordinal)
			if err == nil {
				err = column.store.set(ordinal, &value)
			}
			recordErr = err
		}
	})
	if recordErr != nil {
		return failed(recordErr)
	}
	if err := column.build(workspace, live, uint64(capacity)); err != nil {
		return failed(err)
	}
	if err := column.settleRegions(uint64(capacity)); err != nil {
		return failed(err)
	}
	return column, nil
}

func (s *SortColumns) Column(field string, listCapable bool, mode core.SortMode) *SortColumn {
	return s.columns[SortColumnKey(field, listCapable, mode)]
}

func (s *SortColumns) Record(ordinal, capacity uint32) error {
	if err := s.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	if uint64(ordinal>>wordShift) >= s.live.capacity {
		if err := s.live.reserveExactly(max(bitsetWords(capacity), uint64(ordinal>>wordShift)+1)); err != nil {
			return err
		}
	}
	bits := s.live.all()
	if !hasBit(bits, ordinal) {
		setBit(bits, ordinal)
		s.liveCount++
	}
	if len(s.keys) == 0 {
		return nil
	}
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return coreFailure("workspaceCreate", err)
	}
	defer workspace.Release()
	for _, key := range s.keys {
		if err := s.columns[key].record(workspace, ordinal); err != nil {
			return err
		}
	}
	return nil
}

func (s *SortColumns) Forget(ordinal uint32) {
	bits := s.live.all()
	if hasBit(bits, ordinal) {
		clearBit(bits, ordinal)
		s.liveCount--
	}
	for _, key := range s.keys {
		s.columns[key].forget(ordinal)
	}
}

func (s *SortColumns) rebuildThreshold() int {
	return int(max(s.liveCount>>sortRebuildFractionShift, sortRebuildMinimumThreshold))
}

func (s *SortColumns) Settle(capacity uint32) error {
	if capacity > s.limits.MaxOrdinals {
		return s.limits.checkOrdinal(capacity)
	}
	threshold := s.rebuildThreshold()
	var workspace *core.Workspace
	defer func() {
		if workspace != nil {
			workspace.Release()
		}
	}()
	for _, key := range s.keys {
		column := s.columns[key]
		if len(column.dirty) > threshold {
			if workspace == nil {
				acquired, err := core.AcquireWorkspace()
				if err != nil {
					return coreFailure("workspaceCreate", err)
				}
				workspace = acquired
			}
			if err := column.build(workspace, s.liveBitset(uint64(capacity)), uint64(capacity)); err != nil {
				return err
			}
		}
		if err := column.settleRegions(uint64(capacity)); err != nil {
			return err
		}
	}
	return nil
}

func (s *SortColumns) Live() []uint32 {
	return s.live.all()
}

func (s *SortColumns) Columns() []*SortColumn {
	columns := make([]*SortColumn, len(s.keys))
	for at, key := range s.keys {
		columns[at] = s.columns[key]
	}
	return columns
}

func (s *SortColumns) RegionBytes() uint64 {
	bytes := s.live.bytes()
	for _, key := range s.keys {
		bytes += s.columns[key].RegionBytes()
	}
	return bytes
}

func (s *SortColumns) Release() {
	for _, key := range s.keys {
		s.columns[key].Release()
	}
	clear(s.columns)
	s.keys = nil
	s.live.release()
	s.liveCount = 0
}
