package engine

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

// Document is one record of an index: field names mapped to strings,
// numbers, booleans, lists, nested documents, time.Time values, byte slices,
// and, for a vector field, a []float32 or a list of numbers. Every write
// takes a *Document, and every read returns one.
//
// A Document keeps its keys in the order of a JavaScript object, so that the
// engine stores it byte for byte as the TypeScript engine stores the same
// object literal. Keys that are array indexes, meaning canonical decimal
// numbers from 0 to 4294967294 with no leading zero, come first in ascending
// numeric order, and every other key follows in the order that Set first
// received it. The order holds at every depth, and it decides which group a
// document falls in when a query groups by a field that holds an object.
//
// Build one with NewDocument and Set, or with DocumentFromMap where the key
// order carries no meaning. A write reads the document once at the start of
// the call, so a later Set changes nothing that the engine stored. A
// document that the engine returns belongs to the caller and stays valid
// after later writes, a compaction, and Close; it decodes its stored bytes
// on the first Get, All, Len, or Map, and several goroutines may read one
// document at once.
//
// A copy of a Document refers to the same record as the original, as a copy
// of a Go map does, so a Set through either one changes both. A Document
// takes no Set or Delete while another goroutine uses it.
type Document = model.Document

// NewDocument returns an empty document, ready for Set.
func NewDocument() *Document {
	return model.NewDocument()
}

// DocumentFromMap returns a document that holds the keys and values of
// record. A Go map holds no key order, so the keys are sorted at every
// depth: array indexes first in numeric order, then every other key in byte
// order. Use NewDocument and Set where the stored order matters. A nil map
// gives a nil document.
func DocumentFromMap(record map[string]any) *Document {
	return model.DocumentFromMap(record)
}
