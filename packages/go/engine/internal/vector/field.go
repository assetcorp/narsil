package vector

import (
	"math"
	"sync"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type Config struct {
	FieldName string
	IndexName string
	Dimension int
	Index     *model.VectorIndexConfig
	Storage   model.VectorStorageMode
	Slots     *Slots

	AdmitsBackgroundBytes func(bytes int64) bool
	OnLoadedGraphRepaired func()
}

type fieldConfig struct {
	admitsBackgroundBytes func(bytes int64) bool
	onLoadedGraphRepaired func()

	indexName          string
	fieldName          string
	dimension          int
	dimensionScale     float64
	promotionThreshold int
	filterThreshold    float64
	quantization       model.VectorQuantizationMode
	bits               uint32
	storage            model.VectorStorageMode
	metric             model.VectorMetric
	nativeMetric       core.Metric
	shape              graphShape
	blockBytes         uintptr
}

type Field struct {
	config  fieldConfig
	writeMu sync.Mutex
	current atomic.Pointer[layout]
	slots   *Slots
	writer  *Lease

	store       *storeMemory
	graph       *graphMemory
	fresh       *graphMemory
	earlier     []*graphMemory
	buffer      *flaggedDocuments
	tombstones  *flaggedDocuments
	calibration calibrationState

	shuffledBuildCount int
	hasShuffledBuild   bool
	compactedNodeCount int
	disposed           bool
	revision           atomic.Int64
	pendingLocations   map[string]pendingLocation
	savedFiles         []savedVectorFile
	savedSignature     *fieldSignature
	cold               *coldHold
	coldLoads          sync.WaitGroup
	coldNow            atomic.Pointer[coldHold]
	coldViewNow        atomic.Pointer[coldView]
	filesClosed        atomic.Bool
	restoring          int
	restoreGeneration  int64

	builds buildControl
}

func bitsOf(mode model.VectorQuantizationMode) uint32 {
	switch mode {
	case model.QuantizationOSQ8:
		return 8
	case model.QuantizationOSQ4:
		return 4
	case model.QuantizationOSQ2:
		return 2
	case model.QuantizationOSQ1:
		return 1
	}
	return 0
}

func nativeMetricOf(metric model.VectorMetric) (core.Metric, bool) {
	switch metric {
	case model.MetricCosine:
		return core.MetricCosine, true
	case model.MetricDotProduct:
		return core.MetricDotProduct, true
	case model.MetricEuclidean:
		return core.MetricEuclidean, true
	}
	return core.MetricCosine, false
}

func defaultQuantizationFor(dimension int) model.VectorQuantizationMode {
	if dimension >= osq4MinDimension {
		return model.QuantizationOSQ4
	}
	return model.QuantizationOSQ8
}

func configInvalid(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodeConfigInvalid, message, details)
}

func resolveConfig(config Config) (fieldConfig, error) {
	if config.Dimension <= 0 || config.Dimension > MaxVectorDimension {
		return fieldConfig{}, narsilerr.New(narsilerr.CodeVectorDimensionMismatch,
			"Vector dimension must be a positive integer", map[string]any{"dimension": float64(config.Dimension)})
	}
	index := config.Index
	if index == nil {
		index = &model.VectorIndexConfig{}
	}
	resolved := fieldConfig{
		admitsBackgroundBytes: config.AdmitsBackgroundBytes,
		onLoadedGraphRepaired: config.OnLoadedGraphRepaired,
		indexName:             config.IndexName,
		fieldName:             config.FieldName,
		dimension:             config.Dimension,
		dimensionScale:        float64(config.Dimension) / dimensionScaleUnit,
		promotionThreshold:    index.Threshold.Or(DefaultPromotionThreshold),
		filterThreshold:       math.Max(0, math.Min(1, index.FilterThreshold.Or(DefaultFilterThreshold))),
		quantization:          index.Quantization,
		storage:               config.Storage,
		metric:                model.MetricCosine,
		blockBytes:            blockMaxBytes,
	}
	if resolved.quantization == "" {
		resolved.quantization = defaultQuantizationFor(config.Dimension)
	}
	if resolved.quantization != model.QuantizationNone && bitsOf(resolved.quantization) == 0 {
		return fieldConfig{}, configInvalid("the vector quantization mode is not one the engine knows",
			map[string]any{"quantization": string(resolved.quantization)})
	}
	resolved.bits = bitsOf(resolved.quantization)
	if resolved.storage == "" {
		resolved.storage = model.VectorStorageMemory
	}
	if resolved.storage == model.VectorStorageDisk {
		resolved.blockBytes = diskStorageBlockBytes
	}
	shape := graphShape{m: DefaultM, efConstruction: DefaultEfConstruction}
	if index.HNSW != nil {
		if index.HNSW.Metric != "" {
			resolved.metric = index.HNSW.Metric
		}
		if m, set := index.HNSW.M.Get(); set {
			shape.m = max(m, MinM)
		}
		shape.efConstruction = index.HNSW.EfConstruction.Or(DefaultEfConstruction)
	}
	if shape.m > MaxM || shape.efConstruction < 1 {
		return fieldConfig{}, configInvalid("the graph settings of a vector field are out of range",
			map[string]any{"m": float64(shape.m), "efConstruction": float64(shape.efConstruction)})
	}
	shape.mMax0 = shape.m * 2
	metric, known := nativeMetricOf(resolved.metric)
	if !known {
		return fieldConfig{}, configInvalid("vector metric must be 'cosine', 'dotProduct', or 'euclidean'",
			map[string]any{"metric": string(resolved.metric)})
	}
	resolved.nativeMetric = metric
	shape.metric = metric
	resolved.shape = shape
	return resolved, nil
}

func New(config Config) (*Field, error) {
	resolved, err := resolveConfig(config)
	if err != nil {
		return nil, err
	}
	field := &Field{
		config:           resolved,
		buffer:           newFlaggedDocuments(ordinalUnplaced),
		tombstones:       newFlaggedDocuments(ordinalRemoved),
		calibration:      noCalibration(),
		pendingLocations: map[string]pendingLocation{},
	}
	field.builds.init()
	if err := field.attachSlots(config.Slots); err != nil {
		return nil, err
	}
	store, err := newStoreMemory(resolved.dimension, resolved.bits, resolved.blockBytes, field.slots)
	if err != nil {
		field.detachSlots()
		return nil, err
	}
	field.store = store
	if err := field.publish(store, nil); err != nil {
		store.discard()
		field.detachSlots()
		return nil, err
	}
	return field, nil
}

func (f *Field) attachSlots(shared *Slots) error {
	if shared != nil {
		f.slots = shared.Retain()
	} else {
		own, err := NewSlots()
		if err != nil {
			return err
		}
		f.slots = own
	}
	writer, err := f.slots.acquireWriter()
	if err != nil {
		f.slots.Close()
		f.slots = nil
		return err
	}
	f.writer = writer
	return nil
}

func (f *Field) detachSlots() {
	if f.writer == nil {
		return
	}
	f.writer.Release()
	f.writer = nil
	f.slots.Close()
}

func (f *Field) Slots() *Slots {
	return f.slots
}

func (f *Field) FieldName() string {
	return f.config.fieldName
}

func (f *Field) Dimension() int {
	return f.config.dimension
}

func (f *Field) Metric() model.VectorMetric {
	return f.config.metric
}

func (f *Field) Quantization() model.VectorQuantizationMode {
	return f.config.quantization
}

func (f *Field) Storage() model.VectorStorageMode {
	return f.config.storage
}

func (f *Field) Size() int {
	current := f.acquireLayout()
	if current == nil {
		return 0
	}
	defer current.done()
	return liveSizeOf(current)
}

func liveSizeOf(current *layout) int {
	if current.store == nil {
		return 0
	}
	return int(current.store.liveCount.Load() - current.store.removedCount.Load())
}

func (f *Field) liveSize() int {
	return f.store.size() - f.tombstones.size()
}

func (f *Field) liveOrdinals() []int32 {
	ordinals := []int32{}
	for ordinal := range f.store.slots() {
		if f.store.holdsDocument(ordinal) && f.store.table.flags(ordinal)&ordinalRemoved == 0 {
			ordinals = append(ordinals, ordinal)
		}
	}
	return ordinals
}

func (f *Field) liveDocIDs() []string {
	docIDs := []string{}
	for ordinal := range f.store.slots() {
		docID, held := f.store.docIDOf(ordinal)
		if held && !f.tombstones.has(docID) {
			docIDs = append(docIDs, docID)
		}
	}
	return docIDs
}
