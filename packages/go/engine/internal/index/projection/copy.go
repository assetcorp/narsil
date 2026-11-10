package projection

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func CopyDocument(document *model.Document) *model.Document {
	if document == nil {
		return model.NewDocument()
	}
	return codec.SnapshotDocument(document)
}

func CopyValue(value any) any {
	return codec.SnapshotValue(value)
}

func keepEntry(string, codec.HeldEntry) (any, bool) {
	return nil, true
}

func shallowCopy(document *model.Document) *model.Document {
	return codec.TransformDocument(document, keepEntry)
}
