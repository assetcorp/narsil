package metadata

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

func readSchema(value any, fields *form.Fields) (map[string]string, error) {
	if value == nil {
		return map[string]string{}, nil
	}
	record, ok := is.AsMap(value)
	if !ok {
		fields.Fail("schema", "is not a map")
		return nil, fields.Err()
	}
	if err := schema.RequireValidFieldTypes(record); err != nil {
		return nil, err
	}
	flat := make(map[string]string, len(record))
	for path, fieldType := range record {
		typeName, isText := fieldType.(string)
		if !isText {
			fields.Fail("schema."+path, "is not a string")
			return nil, fields.Err()
		}
		flat[path] = typeName
	}
	return flat, nil
}

func readVectorFields(value any, fields *form.Fields) (map[string]VectorField, error) {
	record, ok := is.AsMap(value)
	if !ok {
		fields.Fail("vector_fields", "is not a map")
		return nil, fields.Err()
	}
	vectors := make(map[string]VectorField, len(record))
	for path, rawField := range record {
		field, isMap := is.AsMap(rawField)
		quantization := any(nil)
		if isMap {
			quantization = field["quantization"]
		}
		if !is.IsQuantizationMode(quantization) {
			return nil, is.Invalid("Index metadata names a vector quantization \""+describe(quantization)+"\" for \""+
				path+"\" this engine does not read", map[string]any{"fieldPath": path})
		}
		dimension, validDimension := is.AsPositive(field["dimension"], math.MaxUint16)
		metric, validMetric := field["metric"].(string)
		if !validDimension || !validMetric {
			fields.Fail("vector_fields."+path, "is not a vector field with a dimension and a metric")
			return nil, fields.Err()
		}
		vectors[path] = VectorField{Dimension: uint16(dimension), Metric: metric, Quantization: quantization.(string)}
	}
	return vectors, nil
}

func readPending(value any) *PendingAnalysis {
	record, ok := is.AsMap(value)
	if !ok {
		return nil
	}
	generation, positive := is.AsPositive(record["generation"], form.MaxSafeInteger)
	language, isText := record["language"].(string)
	if !positive || !isText {
		return nil
	}
	pending := &PendingAnalysis{Generation: generation, Language: language}
	if tokenizer, ok := record["tokenizer"].(string); ok {
		pending.Tokenizer = model.Some(tokenizer)
	}
	if stopWords, ok := record["stop_words"].(string); ok {
		pending.StopWords = model.Some(stopWords)
	}
	if list, ok := is.AsStrings(record["stop_word_list"]); ok {
		pending.StopWordList = model.Some(list)
	}
	return pending
}

func readHeldPartitions(value any) model.Optional[[]uint32] {
	list, ok := value.([]any)
	if !ok {
		return model.Optional[[]uint32]{}
	}
	held := make([]uint32, len(list))
	for index, element := range list {
		partition, valid := is.AsCount(element, math.MaxUint32)
		if !valid {
			return model.Optional[[]uint32]{}
		}
		held[index] = uint32(partition)
	}
	return model.Some(held)
}

func syncInvalid(message string) error {
	return is.Invalid("The device sync state in the index metadata "+message, nil)
}

func readSync(record map[string]any, meta *Metadata) error {
	if raw, present := is.Present(record, "sync"); present {
		setting, ok := is.AsMap(raw)
		if !ok {
			return syncInvalid("holds a sync setting that is not a map")
		}
		enabled, isFlag := setting["enabled"].(bool)
		if !isFlag {
			return syncInvalid("holds a sync setting without a boolean enabled")
		}
		meta.Sync = &SyncSetting{Enabled: enabled}
		for _, slot := range []struct {
			key    string
			reason string
			target *model.Optional[uint64]
		}{
			{"history_max_age_ms", "holds a history age limit that is not a positive whole number", &meta.Sync.HistoryMaxAgeMS},
			{"history_max_bytes", "holds a history byte limit that is not a positive whole number", &meta.Sync.HistoryMaxBytes},
		} {
			limit, has := setting[slot.key]
			if !has {
				continue
			}
			positive, valid := is.AsPositive(limit, form.MaxSafeInteger)
			if !valid {
				return syncInvalid(slot.reason)
			}
			*slot.target = model.Some(positive)
		}
	}
	if raw, present := is.Present(record, "sync_active"); present {
		active, isFlag := raw.(bool)
		if !isFlag {
			return syncInvalid("holds a sync_active that is not a boolean")
		}
		meta.SyncActive = model.Some(active)
	}
	if raw, present := is.Present(record, "sync_epoch"); present {
		epoch, isText := raw.(string)
		if !isText || !IsSyncEpoch(epoch) {
			return syncInvalid("holds an epoch that is not 32 lowercase hexadecimal digits")
		}
		meta.SyncEpoch = model.Some(epoch)
	}
	return nil
}

func readRequired(fields *form.Fields, meta *Metadata) {
	record := fields.Map()
	meta.IndexName = fields.String("index_name")
	meta.Language = DefaultLanguage
	if raw := record["language"]; raw != nil {
		meta.Language = fields.String("language")
	}
	meta.PartitionCount = DefaultPartitionCount
	if raw := record["partition_count"]; raw != nil {
		meta.PartitionCount = uint32(fields.Uint("partition_count", MaxPartitionCount))
	}
	if raw := record["created_at"]; raw != nil {
		meta.CreatedAt = fields.Uint("created_at", form.MaxSafeInteger)
	}
	meta.EngineVersion = DefaultEngineVersion
	if raw := record["engine_version"]; raw != nil {
		meta.EngineVersion = fields.String("engine_version")
	}
	meta.BM25 = DefaultBM25()
	if raw := record["bm25_params"]; raw != nil {
		bm25, ok := is.LenientBM25(raw)
		if !ok {
			fields.Fail("bm25_params", "is not a map")
		}
		meta.BM25 = bm25
	}
}

func Decode(value any, code string) (Metadata, error) {
	fields := form.NewFields(value, "", code, what)
	if err := fields.Err(); err != nil {
		return Metadata{}, err
	}
	record := fields.Map()
	meta := Metadata{}
	readRequired(fields, &meta)
	if err := fields.Err(); err != nil {
		return Metadata{}, err
	}
	flat, err := readSchema(record["schema"], fields)
	if err != nil {
		return Metadata{}, err
	}
	meta.Schema = flat
	if raw := record["vector_fields"]; raw != nil {
		vectors, err := readVectorFields(raw, fields)
		if err != nil {
			return Metadata{}, err
		}
		meta.VectorFields = vectors
	}
	readOptional(record, &meta)
	if err := readChecked(record, &meta); err != nil {
		return Metadata{}, err
	}
	return meta, nil
}

func readChecked(record map[string]any, meta *Metadata) error {
	if raw, has := record["text_storage"]; has {
		storage, isText := raw.(string)
		if !isText || !is.IsStorageMode(storage) {
			return narsilerr.New(narsilerr.CodeConfigInvalid, "text_storage must be 'memory' or 'disk'",
				map[string]any{"textStorage": describe(raw)})
		}
		meta.TextStorage = model.Some(storage)
	}
	if raw, has := record["vector_promotion"]; has {
		promotion, err := is.ReadVectorPromotion(raw, is.Snake, nil)
		if err != nil {
			return err
		}
		meta.VectorPromotion = promotion
	}
	if raw, has := record["pattern_value_limit"]; has {
		limit, positive := is.AsPositive(raw, math.MaxUint32)
		if !positive {
			return is.Invalid("The pattern value limit in the index metadata is "+describe(raw)+
				", but the limit must be a whole number of code points", map[string]any{"patternValueLimit": describe(raw)})
		}
		meta.PatternValueLimit = model.Some(uint32(limit))
	}
	if raw, present := is.Present(record, "synonyms"); present {
		rules, err := is.ParseSynonymRules(raw, "The synonym set in the index metadata is invalid: ")
		if err != nil {
			return err
		}
		meta.Synonyms = model.Some(rules)
	}
	if err := readSync(record, meta); err != nil {
		return err
	}
	if err := readChanges(record, meta); err != nil {
		return err
	}
	state, err := is.ReadQuerySuggestionsState(record, is.Snake)
	if err != nil {
		return err
	}
	meta.QuerySuggestions = state
	return nil
}
