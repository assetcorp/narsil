package cursor

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

const (
	boundTermMatchAll  = "all"
	boundTermMatchAny  = "any"
	boundToleranceAuto = "auto"
)

func boundBoostOf(boost map[string]float64) boundValue {
	if boost == nil {
		return absentValue()
	}
	var builder boundMapBuilder
	for field, weight := range boost {
		builder.put(field, numberValue(weight))
	}
	return builder.value()
}

func boundTermMatchOf(termMatch model.TermMatch) boundValue {
	switch termMatch.Kind() {
	case model.TermMatchAll:
		return stringValue(boundTermMatchAll)
	case model.TermMatchAny:
		return stringValue(boundTermMatchAny)
	case model.TermMatchCount:
		count, _ := termMatch.Count()
		return numberValue(count)
	}
	return absentValue()
}

func boundPinnedOf(pinned []model.PinnedDocument) boundValue {
	if pinned == nil {
		return absentValue()
	}
	members := make([]boundValue, len(pinned))
	for index, placement := range pinned {
		var builder boundMapBuilder
		builder.put("docId", stringValue(placement.DocID))
		builder.put("position", numberValue(float64(placement.Position)))
		members[index] = builder.value()
	}
	return listValue(members)
}

func boundHybridOf(hybrid *model.HybridConfig) boundValue {
	if hybrid == nil {
		return absentValue()
	}
	var builder boundMapBuilder
	builder.put("strategy", nonEmptyString(string(hybrid.Strategy)))
	builder.put("k", optionalInteger(hybrid.K))
	builder.put("alpha", optionalNumber(hybrid.Alpha))
	builder.put("depth", optionalInteger(hybrid.Depth))
	return builder.value()
}

func boundVectorOf(vector *model.VectorQueryConfig) boundValue {
	if vector == nil {
		return absentValue()
	}
	var builder boundMapBuilder
	builder.put("field", stringValue(vector.Field))
	if vector.Value != nil && !vector.Text.IsSet() {
		builder.put("value", boundValue{kind: boundBinary32List, binary32: vector.Value})
	}
	builder.put("text", optionalString(vector.Text))
	builder.put("similarity", optionalNumber(vector.Similarity))
	builder.put("metric", nonEmptyString(string(vector.Metric)))
	builder.put("efSearch", optionalInteger(vector.EfSearch))
	builder.put("oversample", optionalNumber(vector.Oversample))
	return builder.value()
}

func boundScoringOf(scoring model.ScoringMode) boundValue {
	if scoring == "" {
		return stringValue(string(model.ScoringLocal))
	}
	return stringValue(string(scoring))
}

func boundRerankOf(rerank *model.RerankConfig) boundValue {
	var builder boundMapBuilder
	builder.put("adapter", stringValue(rerank.Adapter))
	builder.put("fields", stringList(rerank.Fields))
	builder.put("query", optionalString(rerank.Query))
	builder.put("window", optionalInteger(rerank.Window))
	return builder.value()
}

func bm25FieldSetsValue(pair model.BM25FieldParams) bool {
	return pair.K1.IsSet() || pair.B.IsSet()
}

func bm25SetsValue(params model.BM25Params) bool {
	if params.K1.IsSet() || params.B.IsSet() {
		return true
	}
	for _, pair := range params.Fields {
		if bm25FieldSetsValue(pair) {
			return true
		}
	}
	return false
}

func boundBM25Of(params model.BM25Params) boundValue {
	var builder boundMapBuilder
	builder.put("k1", optionalNumber(params.K1))
	builder.put("b", optionalNumber(params.B))
	var fields boundMapBuilder
	for name, pair := range params.Fields {
		if !bm25FieldSetsValue(pair) {
			continue
		}
		var members boundMapBuilder
		members.put("k1", optionalNumber(pair.K1))
		members.put("b", optionalNumber(pair.B))
		fields.put(name, members.value())
	}
	if fields.entries != nil {
		builder.put("fields", fields.value())
	}
	return builder.value()
}
