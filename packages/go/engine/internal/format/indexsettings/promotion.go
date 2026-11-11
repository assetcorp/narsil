package indexsettings

import (
	"fmt"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type HNSWConfig struct {
	M              model.Optional[uint32]
	EfConstruction model.Optional[uint32]
	Metric         model.Optional[string]
}

type VectorPromotion struct {
	Threshold       model.Optional[uint32]
	FilterThreshold model.Optional[float64]
	HNSW            *HNSWConfig
	Quantization    model.Optional[string]
	Storage         model.Optional[string]
}

func IsQuantizationMode(value any) bool {
	switch value {
	case "osq8", "osq4", "osq2", "osq1", "none":
		return true
	}
	return false
}

func IsStorageMode(value any) bool {
	return value == "memory" || value == "disk"
}

func IsMetric(value any) bool {
	return value == "cosine" || value == "dotProduct" || value == "euclidean"
}

func isSelectivityRatio(value any) (float64, bool) {
	number, ok := AsFinite(value)
	return number, ok && number >= 0 && number <= 1
}

func readHNSW(record map[string]any, keyCase Case, reject Reject) (*HNSWConfig, error) {
	config := &HNSWConfig{}
	present := false
	for _, slot := range []struct {
		key    string
		target *model.Optional[uint32]
	}{
		{"m", &config.M},
		{keyCase.Key("ef_construction", "efConstruction"), &config.EfConstruction},
	} {
		raw, has := record[slot.key]
		if !has {
			continue
		}
		count, positive := AsPositive(raw, math.MaxUint32)
		if positive {
			*slot.target = model.Some(uint32(count))
			present = true
			continue
		}
		if reject != nil {
			return nil, reject("vectorPromotion.hnswConfig." + slot.key + " must be a positive integer")
		}
	}
	if raw, has := record["metric"]; has {
		if metric, ok := raw.(string); ok && IsMetric(metric) {
			config.Metric = model.Some(metric)
			present = true
		} else if reject != nil {
			return nil, reject("vectorPromotion.hnswConfig.metric must be 'cosine', 'dotProduct', or 'euclidean'")
		}
	}
	if !present && reject == nil {
		return nil, nil
	}
	return config, nil
}

func quantizationProblem(value any, reject Reject) error {
	if reject != nil {
		return reject("vectorPromotion.quantization must be 'osq8', 'osq4', 'osq2', 'osq1', or 'none'")
	}
	return Invalid(fmt.Sprintf("Index metadata names a vector quantization %q this engine does not read", fmt.Sprint(value)),
		map[string]any{"quantization": fmt.Sprint(value)})
}

func storageProblem(value any, reject Reject) error {
	if reject != nil {
		return reject("vectorPromotion.storage must be 'memory' or 'disk'")
	}
	return Invalid(fmt.Sprintf("Index metadata names a vector storage %q this engine does not read", fmt.Sprint(value)),
		map[string]any{"storage": fmt.Sprint(value)})
}

func ReadVectorPromotion(value any, keyCase Case, reject Reject) (*VectorPromotion, error) {
	record, ok := AsMap(value)
	if !ok {
		if reject == nil {
			return nil, nil
		}
		return nil, reject("vectorPromotion must be an object")
	}
	promotion := &VectorPromotion{}
	present := false
	hnswKey := keyCase.Key("hnsw_config", "hnswConfig")
	if rawHNSW, has := record[hnswKey]; has {
		hnswRecord, isMap := AsMap(rawHNSW)
		switch {
		case isMap:
			config, err := readHNSW(hnswRecord, keyCase, reject)
			if err != nil {
				return nil, err
			}
			promotion.HNSW = config
			present = present || config != nil
		case reject != nil:
			return nil, reject("vectorPromotion must be an object")
		}
	}
	if raw, has := record["threshold"]; has {
		if threshold, positive := AsPositive(raw, math.MaxUint32); positive {
			promotion.Threshold = model.Some(uint32(threshold))
			present = true
		} else if reject != nil {
			return nil, reject("vectorPromotion.threshold must be a positive integer")
		}
	}
	filterKey := keyCase.Key("filter_threshold", "filterThreshold")
	if raw, has := record[filterKey]; has {
		if ratio, valid := isSelectivityRatio(raw); valid {
			promotion.FilterThreshold = model.Some(ratio)
			present = true
		} else if reject != nil {
			return nil, reject("vectorPromotion.filterThreshold must be a number from 0 to 1")
		}
	}
	if raw, has := record["quantization"]; has {
		if !IsQuantizationMode(raw) {
			return nil, quantizationProblem(raw, reject)
		}
		promotion.Quantization = model.Some(raw.(string))
		present = true
	}
	if raw, has := record["storage"]; has {
		if !IsStorageMode(raw) {
			return nil, storageProblem(raw, reject)
		}
		promotion.Storage = model.Some(raw.(string))
		present = true
	}
	if !present && reject == nil {
		return nil, nil
	}
	return promotion, nil
}

func (promotion VectorPromotion) Value(keyCase Case) codec.OrderedMap {
	entries := codec.OrderedMap{}
	PutOptional(&entries, "threshold", promotion.Threshold, Number[uint32])
	PutOptional(&entries, keyCase.Key("filter_threshold", "filterThreshold"), promotion.FilterThreshold, Number[float64])
	if promotion.HNSW != nil {
		hnsw := codec.OrderedMap{}
		PutOptional(&hnsw, "m", promotion.HNSW.M, Number[uint32])
		PutOptional(&hnsw, keyCase.Key("ef_construction", "efConstruction"), promotion.HNSW.EfConstruction, Number[uint32])
		PutOptional(&hnsw, "metric", promotion.HNSW.Metric, Text)
		Put(&entries, keyCase.Key("hnsw_config", "hnswConfig"), hnsw)
	}
	PutOptional(&entries, "quantization", promotion.Quantization, Text)
	PutOptional(&entries, "storage", promotion.Storage, Text)
	return entries
}
