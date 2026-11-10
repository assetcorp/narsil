package segment

import (
	"encoding/binary"
	"math"
	"slices"
	"strings"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/fieldindex"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
)

func appendFloat64(destination []byte, value float64) []byte {
	return binary.LittleEndian.AppendUint64(destination, math.Float64bits(value))
}

func sortedPaths[V any](indexes map[string]V) []string {
	paths := make([]string, 0, len(indexes))
	for path := range indexes {
		paths = append(paths, path)
	}
	slices.SortFunc(paths, strings.Compare)
	return paths
}

func (plan *layout) noteLengths(current *chunk, document *partition.StoredDocument) {
	if current.lengths == nil {
		current.lengths = make([][]byte, len(plan.lengthNames))
	}
	for at, name := range plan.lengthNames {
		current.lengths[at] = appendUint32(current.lengths[at], document.FieldLengths[name])
	}
}

func (plan *layout) fieldLengths() {
	for _, current := range plan.chunks {
		current.fieldLengthColumns = make([]keyword.FieldLengthColumn, 0, len(plan.lengthNames))
		for at, name := range plan.lengthNames {
			lengths := []byte{}
			if current.lengths != nil && current.lengths[at] != nil {
				lengths = current.lengths[at]
			}
			current.fieldLengthColumns = append(current.fieldLengthColumns,
				keyword.FieldLengthColumn{Field: name, Lengths: lengths})
		}
		current.lengths = nil
	}
}

func (plan *layout) valueColumns(indexes map[string]*fieldindex.Numeric, pick func(*chunk) *[]keyword.ValueColumn) {
	for _, path := range sortedPaths(indexes) {
		values, ordinals := indexes[path].Entries()
		columns := make([]keyword.ValueColumn, len(plan.chunks))
		for at := range columns {
			columns[at].Field = path
			columns[at].Documents = []byte{}
			columns[at].Values = []byte{}
		}
		for at, ordinal := range ordinals {
			owner, ok := plan.owner(ordinal)
			if !ok || math.IsNaN(values[at]) {
				continue
			}
			column := &columns[owner]
			column.Documents = appendUint32(column.Documents, plan.localOf[ordinal])
			column.Values = appendFloat64(column.Values, values[at])
		}
		for at, current := range plan.chunks {
			*pick(current) = append(*pick(current), columns[at])
		}
	}
}

func (plan *layout) owner(ordinal uint32) (int32, bool) {
	if int(ordinal) >= len(plan.chunkOf) || plan.chunkOf[ordinal] < 0 {
		return 0, false
	}
	return plan.chunkOf[ordinal], true
}

func (plan *layout) remapped(ordinals []uint32) [][]byte {
	split := make([][]byte, len(plan.chunks))
	for at := range split {
		split[at] = []byte{}
	}
	for _, ordinal := range ordinals {
		if owner, ok := plan.owner(ordinal); ok {
			split[owner] = appendUint32(split[owner], plan.localOf[ordinal])
		}
	}
	return split
}

func (plan *layout) booleanColumns(indexes map[string]*fieldindex.Boolean) {
	for _, path := range sortedPaths(indexes) {
		trueOrdinals, falseOrdinals := indexes[path].Ordinals()
		trueSplit, falseSplit := plan.remapped(trueOrdinals), plan.remapped(falseOrdinals)
		for at, current := range plan.chunks {
			current.boolean = append(current.boolean, keyword.BooleanColumn{
				Field: path, TrueDocuments: trueSplit[at], FalseDocuments: falseSplit[at]})
		}
	}
}

func (plan *layout) enumColumns(indexes map[string]*fieldindex.Enum) {
	for _, path := range sortedPaths(indexes) {
		columns := make([]keyword.EnumColumn, len(plan.chunks))
		for at := range columns {
			columns[at] = keyword.EnumColumn{Field: path, Values: []string{}, Offsets: appendUint32(nil, 0),
				Documents: []byte{}}
		}
		ordered := indexes[path].Postings()
		slices.SortFunc(ordered, func(left, right fieldindex.EnumPosting) int {
			return strings.Compare(left.Value, right.Value)
		})
		for _, posting := range ordered {
			split := plan.remapped(posting.Ordinals)
			for at := range columns {
				if len(split[at]) == 0 {
					continue
				}
				column := &columns[at]
				column.Values = append(column.Values, posting.Value)
				column.Documents = append(column.Documents, split[at]...)
				column.Offsets = appendUint32(column.Offsets, uint32(len(column.Documents)/4))
			}
		}
		for at, current := range plan.chunks {
			current.enum = append(current.enum, columns[at])
		}
	}
}

func (plan *layout) geopointColumns() {
	geopoints := plan.source.indexes.Geopoints
	for _, path := range sortedPaths(geopoints) {
		index := geopoints[path]
		if index == nil {
			continue
		}
		columns := make([]keyword.GeopointColumn, len(plan.chunks))
		for at := range columns {
			columns[at] = keyword.GeopointColumn{Field: path, Documents: []byte{}, Latitudes: []byte{},
				Longitudes: []byte{}}
		}
		for _, entry := range index.Entries() {
			owner, ok := plan.owner(entry.Ordinal)
			if !ok {
				continue
			}
			column := &columns[owner]
			column.Documents = appendUint32(column.Documents, plan.localOf[entry.Ordinal])
			column.Latitudes = appendFloat64(column.Latitudes, entry.Lat)
			column.Longitudes = appendFloat64(column.Longitudes, entry.Lon)
		}
		for at, current := range plan.chunks {
			current.geopoint = append(current.geopoint, columns[at])
		}
	}
}

func surfaceColumn(forms []partition.SurfaceForm) *keyword.SurfaceFormColumn {
	if len(forms) == 0 {
		return nil
	}
	column := &keyword.SurfaceFormColumn{Offsets: appendUint32(nil, 0)}
	for _, form := range forms {
		column.Text = append(column.Text, form.Surface...)
		column.Offsets = appendUint32(column.Offsets, uint32(len(column.Text)))
		column.Text = append(column.Text, form.Token...)
		column.Offsets = appendUint32(column.Offsets, uint32(len(column.Text)))
		column.Counts = appendUint32(column.Counts, uint32(max(form.Occurrences, 0)))
	}
	return column
}
