package indexconfig

import (
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/schema"
)

const (
	FormatVersion = 5
	what          = "index configuration"
)

type Configuration struct {
	Schema             map[string]string
	SchemaOrder        []string
	Language           string
	AnalysisRevision   model.Optional[string]
	ArrayPositionGap   model.Optional[uint32]
	Tokenizer          model.Optional[string]
	StopWords          model.Optional[string]
	StopWordList       model.Optional[[]string]
	AnalysisGeneration model.Optional[uint64]
	BM25               *is.BM25
	SurfaceForms       model.Optional[bool]
	PartitionConfig    *is.PartitionLimits
	DefaultScoring     model.Optional[string]
	TrackPositions     model.Optional[bool]
	TextStorage        model.Optional[string]
	Strict             model.Optional[bool]
	Required           model.Optional[[]string]
	VectorPromotion    *is.VectorPromotion
	PatternValueLimit  model.Optional[uint32]
	Synonyms           model.Optional[[]is.SynonymRule]
	Embedding          *is.Embedding
	SyncEpoch          model.Optional[string]
	QuerySuggestions   is.QuerySuggestionsState
}

func ArchiveReject(message string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "Invalid index configuration: "+message, nil)
}

func ExportHeaderReject(message string) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, "The document export header "+message, nil)
}

func RequireShape(value any, holder string) (map[string]any, error) {
	record, ok := is.AsMap(value)
	if !ok {
		return nil, is.Invalid("The "+holder+" does not hold an index configuration", nil)
	}
	if _, isMap := is.AsMap(record["schema"]); !isMap {
		return nil, is.Invalid("The "+holder+" holds no schema", nil)
	}
	if language, isText := record["language"].(string); !isText || language == "" {
		return nil, is.Invalid("The "+holder+" holds no language", nil)
	}
	return record, nil
}

func readSchema(record map[string]any) (map[string]string, error) {
	raw, _ := is.AsMap(record["schema"])
	if err := schema.RequireValidFieldTypes(raw); err != nil {
		return nil, err
	}
	flat := make(map[string]string, len(raw))
	for path, fieldType := range raw {
		typeName, isText := fieldType.(string)
		if !isText {
			return nil, narsilerr.New(narsilerr.CodeSchemaInvalidType, "Field \""+path+"\" has an invalid type definition",
				map[string]any{"field": path})
		}
		flat[path] = typeName
	}
	return flat, nil
}

func readBoolean(record map[string]any, key string, reject is.Reject) (model.Optional[bool], error) {
	raw, has := record[key]
	if !has {
		return model.Optional[bool]{}, nil
	}
	flag, ok := raw.(bool)
	if !ok {
		return model.Optional[bool]{}, reject(key + " must be a boolean")
	}
	return model.Some(flag), nil
}

func readAnalysis(record map[string]any, config *Configuration, reject is.Reject) error {
	if raw, has := record["tokenizer"]; has {
		tokenizer, ok := raw.(string)
		if !ok {
			return reject("tokenizer must be a name")
		}
		config.Tokenizer = model.Some(tokenizer)
	}
	rawName, hasName := record["stopWords"]
	rawList, hasList := record["stopWordList"]
	if hasName {
		name, ok := rawName.(string)
		if !ok {
			return reject("stopWords must be a name")
		}
		config.StopWords = model.Some(name)
	}
	if hasList {
		list, ok := is.AsStrings(rawList)
		if !ok {
			return reject("stopWordList must be a list of words")
		}
		config.StopWordList = model.Some(list)
	}
	if hasName && hasList {
		return reject("stopWords and stopWordList cannot both be present")
	}
	if revision, ok := record["analysisRevision"].(string); ok {
		config.AnalysisRevision = model.Some(revision)
	}
	if gap, ok := is.AsCount(record["arrayPositionGap"], math.MaxUint32); ok {
		config.ArrayPositionGap = model.Some(uint32(gap))
	}
	if generation, ok := is.AsPositive(record["analysisGeneration"], form.MaxSafeInteger); ok {
		config.AnalysisGeneration = model.Some(generation)
	}
	return nil
}

func readStorage(record map[string]any, config *Configuration, reject is.Reject) error {
	if raw, has := record["defaultScoring"]; has {
		scoring, ok := raw.(string)
		if !ok || (scoring != "local" && scoring != "dfs" && scoring != "broadcast") {
			return reject("defaultScoring must be 'local', 'dfs', or 'broadcast'")
		}
		config.DefaultScoring = model.Some(scoring)
	}
	if raw, has := record["textStorage"]; has {
		storage, ok := raw.(string)
		if !ok || !is.IsStorageMode(storage) {
			return reject("textStorage must be 'memory' or 'disk'")
		}
		config.TextStorage = model.Some(storage)
	}
	if raw, has := record["required"]; has {
		required, ok := is.AsStrings(raw)
		if !ok {
			return reject("required must be a list of field paths")
		}
		config.Required = model.Some(required)
	}
	if raw, has := record["patternValueLimit"]; has {
		limit, ok := is.AsPositive(raw, math.MaxUint32)
		if !ok {
			return reject("patternValueLimit must be a whole number of code points")
		}
		config.PatternValueLimit = model.Some(uint32(limit))
	}
	if epoch, ok := record["syncEpoch"].(string); ok {
		config.SyncEpoch = model.Some(epoch)
	}
	return nil
}

func readFlags(record map[string]any, config *Configuration, reject is.Reject) error {
	var err error
	if config.SurfaceForms, err = readBoolean(record, "surfaceForms", reject); err != nil {
		return err
	}
	if config.TrackPositions, err = readBoolean(record, "trackPositions", reject); err != nil {
		return err
	}
	config.Strict, err = readBoolean(record, "strict", reject)
	return err
}

func readBlocks(record map[string]any, config *Configuration, reject is.Reject) error {
	if raw, has := record["bm25"]; has {
		bm25, err := is.StrictBM25(raw, reject)
		if err != nil {
			return err
		}
		config.BM25 = &bm25
	}
	if raw, has := record["partitionConfig"]; has {
		limits, _, err := is.ReadPartitionLimits(raw, is.Camel, reject)
		if err != nil {
			return err
		}
		config.PartitionConfig = &limits
	}
	if raw, has := record["vectorPromotion"]; has {
		promotion, err := is.ReadVectorPromotion(raw, is.Camel, reject)
		if err != nil {
			return err
		}
		config.VectorPromotion = promotion
	}
	if raw, has := record["embedding"]; has {
		embedding, _, err := is.ReadEmbedding(raw, reject)
		if err != nil {
			return err
		}
		config.Embedding = &embedding
	}
	if raw, has := record["synonyms"]; has {
		rules, err := is.ParseSynonymRules(raw, "")
		if err != nil {
			problem, isNarsil := narsilerr.As(err)
			if !isNarsil {
				return err
			}
			return reject("synonyms: " + problem.Message)
		}
		config.Synonyms = model.Some(rules)
	}
	return nil
}

func Decode(value any, holder string, reject is.Reject) (Configuration, error) {
	record, err := RequireShape(value, holder)
	if err != nil {
		return Configuration{}, err
	}
	language, _ := record["language"].(string)
	config := Configuration{Language: language}
	if config.Schema, err = readSchema(record); err != nil {
		return Configuration{}, err
	}
	for _, step := range []func(map[string]any, *Configuration, is.Reject) error{readAnalysis, readFlags, readStorage, readBlocks} {
		if err := step(record, &config, reject); err != nil {
			return Configuration{}, err
		}
	}
	if config.QuerySuggestions, err = is.ReadQuerySuggestionsState(record, is.Camel); err != nil {
		return Configuration{}, err
	}
	return config, nil
}
