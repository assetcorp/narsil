package metadata

import (
	"fmt"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func describe(value any) string {
	if value == nil {
		return "null"
	}
	return fmt.Sprint(value)
}

func optionalString(record map[string]any, key string) model.Optional[string] {
	if text, ok := record[key].(string); ok {
		return model.Some(text)
	}
	return model.Optional[string]{}
}

func optionalBool(record map[string]any, key string) model.Optional[bool] {
	if flag, ok := record[key].(bool); ok {
		return model.Some(flag)
	}
	return model.Optional[bool]{}
}

func optionalStrings(record map[string]any, key string) model.Optional[[]string] {
	if list, ok := is.AsStrings(record[key]); ok {
		return model.Some(list)
	}
	return model.Optional[[]string]{}
}

func readOptional(record map[string]any, meta *Metadata) {
	if count, ok := is.AsCount(record["document_count"], form.MaxSafeInteger); ok {
		meta.DocumentCount = model.Some(count)
	}
	if embedding, ok, _ := is.ReadEmbedding(record["embedding"], nil); ok {
		meta.Embedding = &embedding
	}
	meta.SurfaceFormsEnabled = optionalBool(record, "surface_forms_enabled")
	meta.AnalysisRevision = optionalString(record, "analysis_revision")
	if gap, ok := is.AsCount(record["array_position_gap"], math.MaxUint32); ok {
		meta.ArrayPositionGap = model.Some(uint32(gap))
	}
	meta.Tokenizer = optionalString(record, "tokenizer")
	meta.StopWords = optionalString(record, "stop_words")
	meta.StopWordList = optionalStrings(record, "stop_word_list")
	if generation, ok := is.AsPositive(record["analysis_generation"], form.MaxSafeInteger); ok {
		meta.AnalysisGeneration = model.Some(generation)
	}
	meta.PendingAnalysis = readPending(record["pending_analysis"])
	if limits, ok, _ := is.ReadPartitionLimits(record["partition_limits"], is.Snake, nil); ok {
		meta.PartitionLimits = &limits
	}
	if scoring, ok := record["default_scoring"].(string); ok && isScoringMode(scoring) {
		meta.DefaultScoring = model.Some(scoring)
	}
	meta.TrackPositions = optionalBool(record, "track_positions")
	meta.Strict = optionalBool(record, "strict")
	meta.Required = optionalStrings(record, "required")
	if uuid, ok := record["index_uuid"].(string); ok && uuid != "" {
		meta.IndexUUID = model.Some(uuid)
	}
	meta.HeldPartitions = readHeldPartitions(record["held_partitions"])
}

func isScoringMode(value string) bool {
	return value == "local" || value == "dfs" || value == "broadcast"
}
