package indexconfig

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

func (config Configuration) Value() codec.OrderedMap {
	entries := codec.OrderedMap{{Key: "schema", Value: form.SchemaEntries(config.Schema, config.SchemaOrder)},
		{Key: "language", Value: config.Language}}
	is.PutOptional(&entries, "analysisRevision", config.AnalysisRevision, is.Text)
	is.PutOptional(&entries, "arrayPositionGap", config.ArrayPositionGap, is.Number[uint32])
	is.PutOptional(&entries, "tokenizer", config.Tokenizer, is.Text)
	is.PutOptional(&entries, "stopWords", config.StopWords, is.Text)
	is.PutOptional(&entries, "stopWordList", config.StopWordList, is.Texts)
	is.PutOptional(&entries, "analysisGeneration", config.AnalysisGeneration, is.Number[uint64])
	if config.BM25 != nil {
		is.Put(&entries, "bm25", config.BM25.Value())
	}
	is.PutOptional(&entries, "surfaceForms", config.SurfaceForms, is.Flag)
	if config.PartitionConfig != nil {
		is.Put(&entries, "partitionConfig", config.PartitionConfig.Value(is.Camel))
	}
	is.PutOptional(&entries, "defaultScoring", config.DefaultScoring, is.Text)
	is.PutOptional(&entries, "trackPositions", config.TrackPositions, is.Flag)
	is.PutOptional(&entries, "textStorage", config.TextStorage, is.Text)
	is.PutOptional(&entries, "strict", config.Strict, is.Flag)
	is.PutOptional(&entries, "required", config.Required, is.Texts)
	if config.VectorPromotion != nil {
		is.Put(&entries, "vectorPromotion", config.VectorPromotion.Value(is.Camel))
	}
	is.PutOptional(&entries, "patternValueLimit", config.PatternValueLimit, is.Number[uint32])
	if rules, ok := config.Synonyms.Get(); ok {
		is.Put(&entries, "synonyms", is.SynonymValues(rules))
	}
	if config.Embedding != nil {
		is.Put(&entries, "embedding", config.Embedding.Value())
	}
	config.QuerySuggestions.Put(&entries, is.Camel)
	is.PutOptional(&entries, "syncEpoch", config.SyncEpoch, is.Text)
	return entries
}

func Encode(config Configuration) ([]byte, error) {
	payload, err := codec.Marshal(config.Value(), codec.EncodeOptions{ErrorCode: narsilerr.CodePersistenceSaveFailed})
	if err != nil {
		return nil, err
	}
	if len(payload) > MaxIndexConfigurationBytes {
		return nil, is.Invalid("The index configuration takes "+strconv.Itoa(len(payload))+
			" bytes as MessagePack, but an index configuration may take at most "+strconv.Itoa(MaxIndexConfigurationBytes),
			map[string]any{"bytes": len(payload), "maximum": MaxIndexConfigurationBytes})
	}
	return payload, nil
}

func Write(config Configuration, gzip bool) ([]byte, error) {
	payload, err := Encode(config)
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, envelope.PackOptions{FormatVersion: FormatVersion, What: what, Gzip: gzip, Checksum: true})
}

func Read(data []byte, reject is.Reject) (Configuration, envelope.Header, error) {
	opened, err := envelope.OpenChecksummed(data, envelope.Kind{FormatVersion: FormatVersion, What: what, AllowsGzip: true})
	if err != nil {
		return Configuration{}, envelope.Header{}, err
	}
	raw, err := codec.Unmarshal(opened.Payload, codec.DecodeOptions{ErrorCode: narsilerr.CodePersistenceLoadFailed})
	if err != nil {
		return Configuration{}, envelope.Header{}, narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
			"The index configuration is not MessagePack", err, nil)
	}
	config, err := Decode(raw, what, reject)
	config.SchemaOrder = form.SchemaKeyOrder(opened.Payload)
	return config, opened.Header, err
}

func ReadForm(data []byte) ([]byte, error) {
	config, header, err := Read(data, ArchiveReject)
	if err != nil {
		return nil, err
	}
	return form.Encode(map[string]any{"header": form.HeaderOf(header).Value(), "payload": config.Value()})
}

func WriteForm(data []byte) ([]byte, error) {
	parsed, err := form.Decode(data)
	if err != nil {
		return nil, err
	}
	fields := form.NewFields(parsed, "", form.CodeJSONForm, "JSON form of the index configuration")
	header := form.HeaderFrom(fields.Object("header"))
	if err := fields.Err(); err != nil {
		return nil, err
	}
	config, err := Decode(parsed["payload"], "JSON form of the index configuration", ArchiveReject)
	if err != nil {
		return nil, err
	}
	payload, err := Encode(config)
	if err != nil {
		return nil, err
	}
	return envelope.Pack(payload, header.PackOptions(what))
}
