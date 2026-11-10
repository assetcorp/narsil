package model

import (
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type QueryCoverage struct {
	TotalPartitions    int
	QueriedPartitions  int
	TimedOutPartitions int
	FailedPartitions   int
}

type ScoreComponents struct {
	TermFrequencies map[string]float64
	FieldLengths    map[string]float64
	IDF             map[string]float64
}

type HighlightPosition struct {
	Start int
	End   int
}

type HighlightMatch struct {
	Snippet   string
	Positions []HighlightPosition
}

type Hit struct {
	ID              string
	Score           Optional[float64]
	Document        Document
	ScoreComponents *ScoreComponents
	Highlights      map[string]HighlightMatch
}

type FacetCount struct {
	Value string
	Count int
}

type FacetResult struct {
	Values     []FacetCount
	Count      int
	ErrorBound int
}

type GroupResult struct {
	Values       map[string]any
	Hits         []Hit
	Reduced      Optional[any]
	ReducerError string
}

type QueryResult struct {
	Hits          []Hit
	Count         int
	CountExact    bool
	Elapsed       time.Duration
	Cursor        string
	Facets        map[string]FacetResult
	Groups        []GroupResult
	AnalysisStale bool
	Coverage      QueryCoverage
}

type PreflightResult struct {
	Count         int
	CountExact    bool
	Elapsed       time.Duration
	AnalysisStale bool
}

type BatchFailure struct {
	DocID string
	Err   *narsilerr.Error
}

type BatchResult struct {
	Succeeded []string
	Failed    []BatchFailure
}

type ImportRefusal struct {
	Line    int
	Code    string
	Message string
}

type DocumentImportResult struct {
	Imported     int
	RefusedCount int
	Refused      []ImportRefusal
}

type IndexStats struct {
	DocumentCount        int
	PartitionCount       int
	EstimatedMemoryBytes int64
	Language             string
	Schema               Schema
}

type IndexState string

const (
	IndexOpen         IndexState = "open"
	IndexClosed       IndexState = "closed"
	IndexReopenFailed IndexState = "reopen-failed"
)

type IndexInfo struct {
	Name           string
	DocumentCount  int
	PartitionCount int
	Language       string
	AnalysisStale  bool
	State          IndexState
	ReopenCount    int
}

type PartitionStatsResult struct {
	PartitionID          int
	DocumentCount        int
	EstimatedMemoryBytes int64
}

type SuggestedTerm struct {
	Term              string
	DocumentFrequency int
}

type SuggestResult struct {
	Terms         []SuggestedTerm
	Elapsed       time.Duration
	AnalysisStale bool
}

type VectorMaintenanceResult struct {
	FieldName         string
	TombstoneRatio    float64
	GraphCount        int
	BufferSize        int
	Building          bool
	WaitingForMemory  bool
	LoadingFromFiles  bool
	EstimatedCompact  time.Duration
	EstimatedOptimize time.Duration
}

type ListedDocument struct {
	ID       string
	Document Document
}

type ListResult struct {
	Documents []ListedDocument
	Cursor    string
	Total     int
	Elapsed   time.Duration
}
