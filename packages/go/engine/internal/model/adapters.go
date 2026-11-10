package model

import (
	"context"
	"time"
)

type PersistenceAdapter interface {
	Save(ctx context.Context, key string, data []byte) error
	Load(ctx context.Context, key string) ([]byte, bool, error)
	Delete(ctx context.Context, key string) error
	List(ctx context.Context, prefix string) ([]string, error)
}

type FilesystemPersistenceAdapter interface {
	PersistenceAdapter
	Directory() string
}

type InvalidationEvent interface {
	invalidationIndexName() string
}

type PartitionInvalidation struct {
	IndexName        string
	Partitions       []int
	Timestamp        time.Time
	SourceInstanceID string
}

func (e PartitionInvalidation) invalidationIndexName() string {
	return e.IndexName
}

type StatisticsInvalidation struct {
	IndexName  string
	InstanceID string
	Stats      PartitionStatistics
}

func (e StatisticsInvalidation) invalidationIndexName() string {
	return e.IndexName
}

type PartitionStatistics struct {
	TotalDocs         int
	DocFrequencies    map[string]int
	TotalFieldLengths map[string]int
}

type InvalidationAdapter interface {
	Publish(ctx context.Context, event InvalidationEvent) error
	Subscribe(ctx context.Context, handler func(event InvalidationEvent)) error
	Shutdown(ctx context.Context) error
}

type EmbeddingPurpose string

const (
	EmbeddingForDocument EmbeddingPurpose = "document"
	EmbeddingForQuery    EmbeddingPurpose = "query"
)

type EmbeddingAdapter interface {
	Embed(ctx context.Context, input string, purpose EmbeddingPurpose) ([]float32, error)
	Dimensions() int
}

type BatchEmbeddingAdapter interface {
	EmbeddingAdapter
	EmbedBatch(ctx context.Context, inputs []string, purpose EmbeddingPurpose) ([][]float32, error)
}

type RerankAdapter interface {
	Rerank(ctx context.Context, query string, documents []string) ([]float64, error)
}

type AdapterShutdown interface {
	Shutdown(ctx context.Context) error
}
