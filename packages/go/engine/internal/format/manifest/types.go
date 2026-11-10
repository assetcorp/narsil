package manifest

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

const (
	Version         = 7
	EarlierVersion  = 6
	EnvelopeVersion = 2
)

var EnvelopeKind = envelope.Kind{FormatVersion: EnvelopeVersion, What: "segment manifest", AllowsGzip: true}

type TermStart struct {
	PrimaryTerm uint64
	FirstSeqNo  uint64
}

type PartitionCheckpoint struct {
	PartitionID uint32
	LastSeqNo   uint64
	PrimaryTerm uint64
	TermHistory model.Optional[[]TermStart]
}

type Head struct {
	Offset   uint64
	Length   uint32
	Checksum uint32
}

type FileRef struct {
	Key      string
	Bytes    uint64
	Checksum uint32
	Head     model.Optional[Head]
}

type SegmentRef struct {
	ID             uint64
	DocCount       uint32
	TombstoneCount uint32
	File           FileRef
}

type VectorFileRef struct {
	ID    uint64
	Count uint32
	Dead  model.Optional[[]byte]
	File  FileRef
}

type VectorFieldRef struct {
	FieldPath       string
	NextFileID      uint64
	Files           []VectorFileRef
	GraphGeneration uint64
	GraphParts      []FileRef
}

type PartitionEntry struct {
	PartitionID   uint32
	NextSegmentID uint64
	Segments      []SegmentRef
}

type Manifest struct {
	Schema             map[string]string
	Language           string
	AnalysisGeneration uint64
	Checkpoint         []PartitionCheckpoint
	Partitions         []PartitionEntry
	Vectors            []VectorFieldRef
}

func (file VectorFileRef) IsDead(position uint32) bool {
	dead, marked := file.Dead.Get()
	if !marked || position >= file.Count || int(position/8) >= len(dead) {
		return false
	}
	return dead[position/8]&(1<<(position%8)) != 0
}

func (manifest Manifest) Files() []*FileRef {
	var files []*FileRef
	for partition := range manifest.Partitions {
		for segment := range manifest.Partitions[partition].Segments {
			files = append(files, &manifest.Partitions[partition].Segments[segment].File)
		}
	}
	for field := range manifest.Vectors {
		for file := range manifest.Vectors[field].Files {
			files = append(files, &manifest.Vectors[field].Files[file].File)
		}
		for part := range manifest.Vectors[field].GraphParts {
			files = append(files, &manifest.Vectors[field].GraphParts[part])
		}
	}
	return files
}

func (manifest Manifest) ListedKeys() []string {
	files := manifest.Files()
	keys := make([]string, len(files))
	for index, file := range files {
		keys[index] = file.Key
	}
	return keys
}

func (manifest Manifest) LastSeqNo(partitionID uint32) uint64 {
	for _, checkpoint := range manifest.Checkpoint {
		if checkpoint.PartitionID == partitionID {
			return checkpoint.LastSeqNo
		}
	}
	return 0
}

func DeadBytesFor(count uint32) int {
	return int((uint64(count) + 7) / 8)
}
