package metadata

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func vectorFieldsValue(fields map[string]VectorField) map[string]any {
	record := make(map[string]any, len(fields))
	for path, field := range fields {
		record[path] = codec.OrderedMap{
			{Key: "dimension", Value: float64(field.Dimension)},
			{Key: "metric", Value: field.Metric},
			{Key: "quantization", Value: field.Quantization},
		}
	}
	return record
}

func pendingValue(pending PendingAnalysis) codec.OrderedMap {
	entries := codec.OrderedMap{
		{Key: "generation", Value: float64(pending.Generation)},
		{Key: "language", Value: pending.Language},
	}
	is.PutOptional(&entries, "tokenizer", pending.Tokenizer, is.Text)
	is.PutOptional(&entries, "stop_words", pending.StopWords, is.Text)
	is.PutOptional(&entries, "stop_word_list", pending.StopWordList, is.Texts)
	return entries
}

func syncValue(setting SyncSetting) codec.OrderedMap {
	entries := codec.OrderedMap{{Key: "enabled", Value: setting.Enabled}}
	is.PutOptional(&entries, "history_max_age_ms", setting.HistoryMaxAgeMS, is.Number[uint64])
	is.PutOptional(&entries, "history_max_bytes", setting.HistoryMaxBytes, is.Number[uint64])
	return entries
}

func changesValue(setting ChangesSetting) codec.OrderedMap {
	entries := codec.OrderedMap{{Key: "enabled", Value: setting.Enabled}}
	is.PutOptional(&entries, "previous_document", setting.PreviousDocument, is.Flag)
	is.PutOptional(&entries, "history_max_age_ms", setting.HistoryMaxAgeMS, is.Number[uint64])
	is.PutOptional(&entries, "history_max_bytes", setting.HistoryMaxBytes, is.Number[uint64])
	return entries
}

func heldValue(held []uint32) any {
	values := make([]any, len(held))
	for index, partition := range held {
		values[index] = float64(partition)
	}
	return values
}

func synonymsValue(rules []is.SynonymRule) any {
	return is.SynonymValues(rules)
}

func (meta Metadata) Value() codec.OrderedMap {
	entries := codec.OrderedMap{
		{Key: "index_name", Value: meta.IndexName},
		{Key: "schema", Value: form.SchemaEntries(meta.Schema, meta.SchemaOrder)},
		{Key: "language", Value: meta.Language},
		{Key: "partition_count", Value: float64(meta.PartitionCount)},
		{Key: "bm25_params", Value: meta.BM25.Value()},
		{Key: "created_at", Value: float64(meta.CreatedAt)},
		{Key: "engine_version", Value: meta.EngineVersion},
	}
	if meta.VectorFields != nil {
		is.Put(&entries, "vector_fields", vectorFieldsValue(meta.VectorFields))
	}
	is.PutOptional(&entries, "document_count", meta.DocumentCount, is.Number[uint64])
	is.PutOptional(&entries, "saved_bytes", meta.SavedBytes, is.Number[uint64])
	if meta.Embedding != nil {
		is.Put(&entries, "embedding", meta.Embedding.Value())
	}
	is.PutOptional(&entries, "surface_forms_enabled", meta.SurfaceFormsEnabled, is.Flag)
	is.PutOptional(&entries, "analysis_revision", meta.AnalysisRevision, is.Text)
	is.PutOptional(&entries, "array_position_gap", meta.ArrayPositionGap, is.Number[uint32])
	is.PutOptional(&entries, "tokenizer", meta.Tokenizer, is.Text)
	is.PutOptional(&entries, "stop_words", meta.StopWords, is.Text)
	is.PutOptional(&entries, "stop_word_list", meta.StopWordList, is.Texts)
	is.PutOptional(&entries, "analysis_generation", meta.AnalysisGeneration, is.Number[uint64])
	if meta.PendingAnalysis != nil {
		is.Put(&entries, "pending_analysis", pendingValue(*meta.PendingAnalysis))
	}
	if meta.PartitionLimits != nil {
		is.Put(&entries, "partition_limits", meta.PartitionLimits.Value(is.Snake))
	}
	is.PutOptional(&entries, "default_scoring", meta.DefaultScoring, is.Text)
	is.PutOptional(&entries, "track_positions", meta.TrackPositions, is.Flag)
	is.PutOptional(&entries, "text_storage", meta.TextStorage, is.Text)
	is.PutOptional(&entries, "strict", meta.Strict, is.Flag)
	is.PutOptional(&entries, "required", meta.Required, is.Texts)
	if meta.VectorPromotion != nil {
		is.Put(&entries, "vector_promotion", meta.VectorPromotion.Value(is.Snake))
	}
	is.PutOptional(&entries, "pattern_value_limit", meta.PatternValueLimit, is.Number[uint32])
	is.PutOptional(&entries, "index_uuid", meta.IndexUUID, is.Text)
	is.PutOptional(&entries, "held_partitions", meta.HeldPartitions, heldValue)
	if rules, ok := meta.Synonyms.Get(); ok && len(rules) > 0 {
		is.Put(&entries, "synonyms", synonymsValue(rules))
	}
	if meta.Sync != nil {
		is.Put(&entries, "sync", syncValue(*meta.Sync))
	}
	is.PutOptional(&entries, "sync_active", meta.SyncActive, is.Flag)
	is.PutOptional(&entries, "sync_epoch", meta.SyncEpoch, is.Text)
	if meta.Changes != nil {
		is.Put(&entries, "changes", changesValue(*meta.Changes))
	}
	meta.QuerySuggestions.Put(&entries, is.Snake)
	return entries
}

func Encode(meta Metadata) ([]byte, error) {
	return codec.Marshal(meta.Value(), codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
}

func Write(meta Metadata, gzip bool, checksum bool) ([]byte, error) {
	payload, err := Encode(meta)
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, envelope.PackOptions{FormatVersion: FormatVersion, What: what, Gzip: gzip, Checksum: checksum})
}

func Read(data []byte) (Metadata, envelope.Header, error) {
	opened, err := envelope.OpenUpTo(data, FormatVersion, what)
	if err != nil {
		return Metadata{}, envelope.Header{}, err
	}
	raw, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return Metadata{}, envelope.Header{}, err
	}
	meta, err := Decode(raw, narsilerr.CodePersistenceLoadFailed)
	meta.SchemaOrder = form.SchemaKeyOrder(opened.Payload)
	return meta, opened.Header, err
}

func ReadForm(data []byte) ([]byte, error) {
	meta, header, err := Read(data)
	if err != nil {
		return nil, err
	}
	return form.Encode(map[string]any{"header": form.HeaderOf(header).Value(), "payload": meta.Value()})
}

func WriteForm(data []byte) ([]byte, error) {
	parsed, err := form.Decode(data)
	if err != nil {
		return nil, err
	}
	fields := form.NewFields(parsed, "", form.CodeJSONForm, "JSON form of the index metadata")
	header := form.HeaderFrom(fields.Object("header"))
	if err := fields.Err(); err != nil {
		return nil, err
	}
	meta, err := Decode(parsed["payload"], form.CodeJSONForm)
	if err != nil {
		return nil, err
	}
	payload, err := Encode(meta)
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, header.PackOptions(what))
}
