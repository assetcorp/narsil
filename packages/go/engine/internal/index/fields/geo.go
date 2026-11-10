package fields

import (
	"cmp"
	"math"
	"slices"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

type geoReference struct {
	pending bool
	row     int
	code    uint64
}

type geoRow struct {
	code    uint64
	lat     float64
	lon     float64
	ordinal uint32
}

type Geo struct {
	limits         Limits
	codes          array[uint64]
	lat            array[float64]
	lon            array[float64]
	ordinals       array[uint32]
	placed         uint64
	removedRows    []uint64
	pending        []geoRow
	pendingRemoved map[int]struct{}
	byDocument     map[uint32]geoReference
	present        presence
}

func NewGeo(limits Limits) (*Geo, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	rows := uint64(limits.MaxOrdinals)
	return &Geo{
		limits:         limits,
		codes:          newArray[uint64]("geo codes", rows),
		lat:            newArray[float64]("geo latitudes", rows),
		lon:            newArray[float64]("geo longitudes", rows),
		ordinals:       newArray[uint32]("geo ordinals", rows),
		pendingRemoved: map[int]struct{}{},
		byDocument:     map[uint32]geoReference{},
		present:        newPresence("geo present bitset", limits.MaxOrdinals),
	}, nil
}

func axisCell(value, lowest, span float64) uint64 {
	cell := math.Floor(((value - lowest) / span) * geoCellsPerAxis)
	if !(cell > 0) {
		return 0
	}
	if cell >= geoCellsPerAxis {
		return geoCellsPerAxis - 1
	}
	return uint64(cell)
}

func LocationCode(lat, lon float64) uint64 {
	row := axisCell(lat, -maxLatitudeDegrees, 2*maxLatitudeDegrees)
	column := axisCell(lon, -maxLongitudeDegrees, fullTurnDegrees)
	code := uint64(0)
	for bit := geoCodeBitsPerAxis - 1; bit >= 0; bit-- {
		code = code*4 + ((row>>bit)&1)*2 + ((column >> bit) & 1)
	}
	return code
}

func (g *Geo) Insert(ordinal uint32, lat, lon float64) error {
	if err := g.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	return g.insert(ordinal, lat, lon)
}

func (g *Geo) insert(ordinal uint32, lat, lon float64) error {
	g.present.invalidate()
	if existing, held := g.byDocument[ordinal]; held {
		if err := g.removeDocument(ordinal, existing); err != nil {
			return err
		}
	}
	g.pending = append(g.pending, geoRow{code: LocationCode(lat, lon), lat: lat, lon: lon, ordinal: ordinal})
	g.byDocument[ordinal] = geoReference{pending: true, row: len(g.pending) - 1}
	return nil
}

func (g *Geo) Remove(ordinal uint32) error {
	existing, held := g.byDocument[ordinal]
	if !held {
		return nil
	}
	return g.removeDocument(ordinal, existing)
}

func (g *Geo) firstAfter(code uint64, ordinal uint32) uint64 {
	codes := g.codes.prefix(g.placed)
	ordinals := g.ordinals.prefix(g.placed)
	low, high := uint64(0), g.placed
	for low < high {
		middle := low + (high-low)/2
		if codes[middle] > code || (codes[middle] == code && ordinals[middle] > ordinal) {
			high = middle
		} else {
			low = middle + 1
		}
	}
	return low
}

func (g *Geo) removeDocument(ordinal uint32, reference geoReference) error {
	g.present.invalidate()
	delete(g.byDocument, ordinal)
	if reference.pending {
		g.pendingRemoved[reference.row] = struct{}{}
	} else {
		g.removedRows = append(g.removedRows, g.firstAfter(reference.code, ordinal)-1)
	}
	removed := uint64(len(g.removedRows) + len(g.pendingRemoved))
	held := g.placed + uint64(len(g.pending))
	if removed >= pendingRemovalMergeFloor && removed*pendingRemovalMergeDivisor >= held {
		return g.ensureSorted()
	}
	return nil
}

func (g *Geo) dropRemovedRows() {
	slices.Sort(g.removedRows)
	codes, lat, lon, ordinals := g.codes.all(), g.lat.all(), g.lon.all(), g.ordinals.all()
	write := g.removedRows[0]
	for at, row := range g.removedRows {
		end := g.placed
		if at+1 < len(g.removedRows) {
			end = g.removedRows[at+1]
		}
		for read := row + 1; read < end; read++ {
			codes[write], lat[write], lon[write], ordinals[write] = codes[read], lat[read], lon[read], ordinals[read]
			write++
		}
	}
	g.placed = write
	g.removedRows = g.removedRows[:0]
}

func (g *Geo) reserve(rows uint64) error {
	minimum := uint64(1)
	if err := g.codes.reserve(rows, minimum); err != nil {
		return err
	}
	if err := g.lat.reserve(rows, minimum); err != nil {
		return err
	}
	if err := g.lon.reserve(rows, minimum); err != nil {
		return err
	}
	return g.ordinals.reserve(rows, minimum)
}

func (g *Geo) ensureSorted() error {
	if len(g.removedRows) > 0 {
		g.dropRemovedRows()
	}
	if len(g.pendingRemoved) > 0 {
		kept := g.pending[:0]
		for at, row := range g.pending {
			if _, removed := g.pendingRemoved[at]; !removed {
				kept = append(kept, row)
			}
		}
		g.pending = kept
		clear(g.pendingRemoved)
	}
	if len(g.pending) == 0 {
		return nil
	}
	total := g.placed + uint64(len(g.pending))
	if err := g.reserve(total); err != nil {
		return err
	}
	slices.SortFunc(g.pending, func(left, right geoRow) int {
		if left.code != right.code {
			return cmp.Compare(left.code, right.code)
		}
		return cmp.Compare(left.ordinal, right.ordinal)
	})
	codes, lat, lon, ordinals := g.codes.all(), g.lat.all(), g.lon.all(), g.ordinals.all()
	left, right, write := int64(g.placed)-1, int64(len(g.pending))-1, int64(total)-1
	for right >= 0 {
		next := g.pending[right]
		if left >= 0 && (codes[left] > next.code || (codes[left] == next.code && ordinals[left] > next.ordinal)) {
			codes[write], lat[write], lon[write], ordinals[write] = codes[left], lat[left], lon[left], ordinals[left]
			left--
		} else {
			codes[write], lat[write], lon[write], ordinals[write] = next.code, next.lat, next.lon, next.ordinal
			g.byDocument[next.ordinal] = geoReference{code: next.code}
			right--
		}
		write--
	}
	g.placed = total
	g.pending = g.pending[:0]
	return nil
}

func (g *Geo) Settle(capacity uint32) error {
	if err := g.ensureSorted(); err != nil {
		return err
	}
	ordinals := g.ordinals.prefix(g.placed)
	return g.present.rebuild(capacity, func(bits []uint32) {
		for _, ordinal := range ordinals {
			setBit(bits, ordinal)
		}
	})
}

func (g *Geo) Index() *core.GeoIndex {
	return &core.GeoIndex{
		Codes: g.codes.prefix(g.placed), Lat: g.lat.prefix(g.placed),
		Lon: g.lon.prefix(g.placed), Ordinals: g.ordinals.prefix(g.placed),
	}
}

func (g *Geo) Present() []uint32 {
	return g.present.view()
}

func (g *Geo) Count() uint64 {
	return uint64(len(g.byDocument))
}

func (g *Geo) RegionBytes() uint64 {
	return g.codes.bytes() + g.lat.bytes() + g.lon.bytes() + g.ordinals.bytes() + g.present.bytes()
}

func (g *Geo) HostBytes() uint64 {
	return uint64(cap(g.pending))*geoRowBytes + uint64(cap(g.removedRows))*8 +
		uint64(len(g.byDocument)+len(g.pendingRemoved))*hashEntryBytes
}

func (g *Geo) Release() {
	g.codes.release()
	g.lat.release()
	g.lon.release()
	g.ordinals.release()
	g.present.release()
	g.placed = 0
	g.pending, g.removedRows = nil, nil
	clear(g.pendingRemoved)
	clear(g.byDocument)
}
