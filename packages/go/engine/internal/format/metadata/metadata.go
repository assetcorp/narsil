package metadata

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

const (
	FormatVersion = 1
	what          = "index metadata"
)

type VectorField struct {
	Dimension    uint16
	Metric       string
	Quantization string
}

type PendingAnalysis struct {
	Generation   uint64
	Language     string
	Tokenizer    model.Optional[string]
	StopWords    model.Optional[string]
	StopWordList model.Optional[[]string]
}

type SyncSetting struct {
	Enabled         bool
	HistoryMaxAgeMS model.Optional[uint64]
	HistoryMaxBytes model.Optional[uint64]
}

type ChangesSetting struct {
	Enabled          bool
	PreviousDocument model.Optional[bool]
	HistoryMaxAgeMS  model.Optional[uint64]
	HistoryMaxBytes  model.Optional[uint64]
}

type Metadata struct {
	IndexName           string
	Schema              map[string]string
	SchemaOrder         []string
	Language            string
	PartitionCount      uint32
	DocumentCount       model.Optional[uint64]
	SavedBytes          model.Optional[uint64]
	BM25                indexsettings.BM25
	CreatedAt           uint64
	EngineVersion       string
	VectorFields        map[string]VectorField
	Embedding           *indexsettings.Embedding
	SurfaceFormsEnabled model.Optional[bool]
	AnalysisRevision    model.Optional[string]
	ArrayPositionGap    model.Optional[uint32]
	Tokenizer           model.Optional[string]
	StopWords           model.Optional[string]
	StopWordList        model.Optional[[]string]
	AnalysisGeneration  model.Optional[uint64]
	PendingAnalysis     *PendingAnalysis
	PartitionLimits     *indexsettings.PartitionLimits
	DefaultScoring      model.Optional[string]
	TrackPositions      model.Optional[bool]
	TextStorage         model.Optional[string]
	Strict              model.Optional[bool]
	Required            model.Optional[[]string]
	VectorPromotion     *indexsettings.VectorPromotion
	PatternValueLimit   model.Optional[uint32]
	IndexUUID           model.Optional[string]
	HeldPartitions      model.Optional[[]uint32]
	Synonyms            model.Optional[[]indexsettings.SynonymRule]
	Sync                *SyncSetting
	SyncActive          model.Optional[bool]
	SyncEpoch           model.Optional[string]
	Changes             *ChangesSetting
	QuerySuggestions    indexsettings.QuerySuggestionsState
}

func (meta Metadata) SyncHistoryActive() bool {
	active, _ := meta.SyncActive.Get()
	return meta.Sync != nil && meta.Sync.Enabled && active
}

func (meta Metadata) ChangesEnabled() bool {
	return meta.Changes != nil && meta.Changes.Enabled
}

func (meta Metadata) KeepsHistory() bool {
	return meta.SyncHistoryActive() || meta.ChangesEnabled()
}

const syncEpochLength = 32

func DefaultBM25() indexsettings.BM25 {
	return indexsettings.BM25{BM25Pair: indexsettings.BM25Pair{K1: model.Some(DefaultBM25K1), B: model.Some(DefaultBM25B)}}
}

func IsSyncEpoch(value string) bool {
	if len(value) != syncEpochLength {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
