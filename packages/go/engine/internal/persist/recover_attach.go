package persist

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/keyword"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/frozen"
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/partition"
	"github.com/assetcorp/narsil/packages/go/engine/internal/persist/checkpoint"
)

const insertsEveryDocument = -1

func routesWhole(target *index.Index, partitionID int, segment checkpoint.StoredSegment) bool {
	if partitionID < 0 || partitionID >= target.PartitionCount() {
		return false
	}
	for ordinal := range segment.DocumentTotal() {
		if target.RoutePartition(segment.DocumentID(ordinal)) != partitionID {
			return false
		}
	}
	return true
}

func storedSurfaces(column *keyword.SurfaceFormColumn) []frozen.SurfaceForm {
	if column == nil {
		return nil
	}
	forms := make([]frozen.SurfaceForm, column.Counts.Len())
	for entry := range forms {
		forms[entry] = frozen.SurfaceForm{Surface: column.Surface(entry), Token: column.SurfaceToken(entry),
			Occurrences: int(column.Counts.At(entry))}
	}
	return forms
}

func storedLengthColumns(columns []keyword.FieldLengthColumn) []partition.StoredLengthColumn {
	converted := make([]partition.StoredLengthColumn, len(columns))
	for at, column := range columns {
		lengths := make([]uint32, column.Lengths.Len())
		for ordinal := range lengths {
			lengths[ordinal] = column.Lengths.At(ordinal)
		}
		converted[at] = partition.StoredLengthColumn{Field: column.Field, Lengths: lengths}
	}
	return converted
}

func attachStored(target *index.Index, partitionID int, segment checkpoint.StoredSegment) error {
	documents := make([]partition.Document, segment.DocumentTotal())
	for ordinal := range documents {
		fields, err := segment.StoredDocument(ordinal)
		if err != nil {
			return err
		}
		documents[ordinal] = partition.Document{ID: segment.DocumentID(ordinal), Fields: fields}
	}
	surfaces, err := segment.SurfaceForms()
	if err != nil {
		return err
	}
	return target.AttachStoredSegment(partitionID, partition.StoredSegment{Documents: documents,
		FieldNames: segment.FieldNames(), TracksPositions: segment.TracksPositions(), PagedOrigin: segment.HoldsPagedText(),
		LengthColumns: storedLengthColumns(segment.FieldLengthColumns()), Surfaces: storedSurfaces(surfaces),
		TokenCount: segment.TokenCount(), Token: segment.Token,
		VisitRows: func(at int, add func(ordinal uint32, frequency, field uint16, positions []uint32)) error {
			return segment.VisitRows(at, add)
		}})
}
