package indexsettings

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type Reject func(message string) error

type BM25Pair struct {
	K1 model.Optional[float64]
	B  model.Optional[float64]
}

type BM25 struct {
	BM25Pair
	Fields map[string]BM25Pair
}

type PartitionLimits struct {
	MaxDocsPerPartition model.Optional[uint32]
	MaxPartitions       model.Optional[uint32]
	Watermark           model.Optional[float64]
}

type EmbeddingSource struct {
	Paths []string
	List  bool
}

type Embedding struct {
	Adapter model.Optional[string]
	Fields  map[string]EmbeddingSource
}

func lenientPair(record map[string]any) BM25Pair {
	pair := BM25Pair{}
	if k1, ok := record["k1"].(float64); ok {
		pair.K1 = model.Some(k1)
	}
	if b, ok := record["b"].(float64); ok {
		pair.B = model.Some(b)
	}
	return pair
}

func LenientBM25(value any) (BM25, bool) {
	record, ok := AsMap(value)
	if !ok {
		return BM25{}, false
	}
	bm25 := BM25{BM25Pair: lenientPair(record)}
	if fields, isMap := AsMap(record["fields"]); isMap {
		bm25.Fields = make(map[string]BM25Pair, len(fields))
		for name, entry := range fields {
			if pairRecord, isPair := AsMap(entry); isPair {
				bm25.Fields[name] = lenientPair(pairRecord)
			}
		}
	}
	return bm25, true
}

func strictPair(record map[string]any, label string, reject Reject) (BM25Pair, error) {
	pair := BM25Pair{}
	for _, key := range []string{"k1", "b"} {
		value, present := record[key]
		if !present {
			continue
		}
		number, finite := AsFinite(value)
		if !finite {
			return pair, reject(label + " " + key + " must be a finite number")
		}
		if key == "k1" {
			pair.K1 = model.Some(number)
		} else {
			pair.B = model.Some(number)
		}
	}
	return pair, nil
}

func StrictBM25(value any, reject Reject) (BM25, error) {
	record, ok := AsMap(value)
	if !ok {
		return BM25{}, reject("bm25 must be an object")
	}
	pair, err := strictPair(record, "bm25", reject)
	if err != nil {
		return BM25{}, err
	}
	bm25 := BM25{BM25Pair: pair}
	rawFields, present := record["fields"]
	if !present {
		return bm25, nil
	}
	fields, isMap := AsMap(rawFields)
	if !isMap {
		return BM25{}, reject("bm25 fields must be an object")
	}
	bm25.Fields = make(map[string]BM25Pair, len(fields))
	for name, entry := range fields {
		pairRecord, isPair := AsMap(entry)
		if !isPair {
			return BM25{}, reject("bm25 fields must map each field to an object")
		}
		fieldPair, err := strictPair(pairRecord, "bm25 field", reject)
		if err != nil {
			return BM25{}, err
		}
		bm25.Fields[name] = fieldPair
	}
	return bm25, nil
}

func pairValue(pair BM25Pair) codec.OrderedMap {
	entries := codec.OrderedMap{}
	PutOptional(&entries, "k1", pair.K1, Number[float64])
	PutOptional(&entries, "b", pair.B, Number[float64])
	return entries
}

func (bm25 BM25) Value() codec.OrderedMap {
	entries := pairValue(bm25.BM25Pair)
	if bm25.Fields != nil {
		fields := make(map[string]any, len(bm25.Fields))
		for name, pair := range bm25.Fields {
			fields[name] = pairValue(pair)
		}
		Put(&entries, "fields", fields)
	}
	return entries
}

func isWatermark(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && number > 0 && number <= 1
}

func ReadPartitionLimits(value any, keyCase Case, reject Reject) (PartitionLimits, bool, error) {
	record, ok := AsMap(value)
	if !ok {
		if reject == nil {
			return PartitionLimits{}, false, nil
		}
		return PartitionLimits{}, false, reject("partitionConfig must be an object")
	}
	limits := PartitionLimits{}
	present := false
	for _, slot := range []struct {
		key     string
		target  *model.Optional[uint32]
		readMax uint64
		keepMax uint64
	}{
		{keyCase.Key("max_docs_per_partition", "maxDocsPerPartition"), &limits.MaxDocsPerPartition,
			math.MaxUint32, math.MaxUint32},
		{keyCase.Key("max_partitions", "maxPartitions"), &limits.MaxPartitions,
			form.MaxSafeInteger, MaxPartitionCount},
	} {
		raw, has := record[slot.key]
		if !has {
			continue
		}
		count, positive := AsPositive(raw, slot.readMax)
		if positive {
			*slot.target = model.Some(uint32(min(count, slot.keepMax)))
			present = true
			continue
		}
		if reject != nil {
			return PartitionLimits{}, false, reject("partitionConfig " + slot.key + " must be a positive integer")
		}
	}
	watermarkKey := "watermark"
	if raw, has := record[watermarkKey]; has {
		watermark, valid := isWatermark(raw)
		if valid {
			limits.Watermark = model.Some(watermark)
			present = true
		} else if reject != nil {
			return PartitionLimits{}, false, reject("partitionConfig watermark must be above 0 and at most 1")
		}
	}
	return limits, present || reject != nil, nil
}

func (limits PartitionLimits) Value(keyCase Case) codec.OrderedMap {
	entries := codec.OrderedMap{}
	PutOptional(&entries, keyCase.Key("max_docs_per_partition", "maxDocsPerPartition"), limits.MaxDocsPerPartition, Number[uint32])
	PutOptional(&entries, keyCase.Key("max_partitions", "maxPartitions"), limits.MaxPartitions, Number[uint32])
	PutOptional(&entries, "watermark", limits.Watermark, Number[float64])
	return entries
}

func embeddingSourceOf(value any) (EmbeddingSource, bool) {
	if path, ok := value.(string); ok {
		return EmbeddingSource{Paths: []string{path}}, true
	}
	paths, ok := AsStrings(value)
	return EmbeddingSource{Paths: paths, List: true}, ok
}

func ReadEmbedding(value any, reject Reject) (Embedding, bool, error) {
	record, ok := AsMap(value)
	if !ok {
		if reject == nil {
			return Embedding{}, false, nil
		}
		return Embedding{}, false, reject("embedding must be an object")
	}
	embedding := Embedding{}
	if rawAdapter, has := record["adapter"]; has {
		adapter, isText := rawAdapter.(string)
		if isText {
			embedding.Adapter = model.Some(adapter)
		} else if reject != nil {
			return Embedding{}, false, reject("embedding adapter must be a name")
		}
	}
	fields, isMap := AsMap(record["fields"])
	if !isMap {
		if reject == nil {
			return Embedding{}, false, nil
		}
		return Embedding{}, false, reject("embedding fields must be an object")
	}
	embedding.Fields = make(map[string]EmbeddingSource, len(fields))
	for name, rawSource := range fields {
		source, valid := embeddingSourceOf(rawSource)
		if !valid {
			if reject == nil {
				return Embedding{}, false, nil
			}
			return Embedding{}, false, reject("embedding fields must map vector fields to source paths")
		}
		embedding.Fields[name] = source
	}
	return embedding, true, nil
}

func (embedding Embedding) Value() codec.OrderedMap {
	entries := codec.OrderedMap{}
	PutOptional(&entries, "adapter", embedding.Adapter, Text)
	fields := make(map[string]any, len(embedding.Fields))
	for name, source := range embedding.Fields {
		if source.List {
			fields[name] = Texts(source.Paths)
			continue
		}
		if len(source.Paths) == 1 {
			fields[name] = source.Paths[0]
		}
	}
	Put(&entries, "fields", fields)
	return entries
}
