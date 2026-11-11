package model

import "github.com/assetcorp/narsil/packages/go/engine/internal/codec"

type Document = codec.Document

func NewDocument() *Document {
	return codec.NewDocument()
}

func DocumentFromMap(record map[string]any) *Document {
	return codec.DocumentFromMap(record)
}
