package segment

import (
	"encoding/binary"
	"math"
	"strconv"
)

const (
	removalTripleValues     = 3
	removalValueBytes       = 4
	removalTripleBytes      = removalTripleValues * removalValueBytes
	removalValuesPerTriple  = 2
	removalBucketNamePrefix = "removals-"
)

type removalBucket struct {
	scratch *scratchFile
	triples int64
}

type removalSpill struct {
	buckets           []*removalBucket
	ordinalsPerBucket int
	documentCount     int
	triple            [removalTripleBytes]byte
}

func removalBucketCount(upperBoundTriples int64) int {
	wanted := (upperBoundTriples*removalTripleBytes + removalBucketTargetBytes - 1) / removalBucketTargetBytes
	return int(max(1, min(largestRemovalBucketCount, wanted)))
}

func openRemovalSpill(scratchPath string, documentCount int, upperBoundTriples int64) (*removalSpill, error) {
	count := removalBucketCount(upperBoundTriples)
	spill := &removalSpill{ordinalsPerBucket: max(1, (documentCount+count-1)/count), documentCount: documentCount}
	for at := range count {
		scratch, err := openScratch(scratchPath+scratchSectionInfix+removalBucketNamePrefix+strconv.Itoa(at),
			removalBucketWriteBufferBytes)
		if err != nil {
			spill.discard()
			return nil, err
		}
		spill.buckets = append(spill.buckets, &removalBucket{scratch: scratch})
	}
	return spill, nil
}

func (spill *removalSpill) add(ordinal uint32, token uint32, occurrences uint32) error {
	bucket := spill.buckets[min(int(ordinal)/spill.ordinalsPerBucket, len(spill.buckets)-1)]
	binary.LittleEndian.PutUint32(spill.triple[0:], ordinal)
	binary.LittleEndian.PutUint32(spill.triple[removalValueBytes:], token)
	binary.LittleEndian.PutUint32(spill.triple[2*removalValueBytes:], occurrences)
	bucket.triples++
	return bucket.scratch.write(spill.triple[:])
}

func (spill *removalSpill) drainBucket(bucket *removalBucket, first int, end int, firstValue uint64,
	emit func(offsets []byte, values []byte) error) (uint64, error) {
	stored, err := bucket.scratch.readAll()
	if err != nil {
		return 0, err
	}
	if int64(len(stored)) != bucket.triples*removalTripleBytes {
		return 0, scratchFailed(`The removal bucket "`+bucket.scratch.path+`" holds the wrong number of bytes`,
			bucket.scratch.path, nil)
	}
	span := end - first
	counts := make([]uint64, span+1)
	for at := 0; at < len(stored); at += removalTripleBytes {
		row := int(binary.LittleEndian.Uint32(stored[at:])) - first
		if row < 0 || row >= span {
			return 0, scratchFailed(`The removal bucket "`+bucket.scratch.path+`" holds a document outside its range`,
				bucket.scratch.path, nil)
		}
		counts[row+1] += removalValuesPerTriple
	}
	for at := range span {
		counts[at+1] += counts[at]
	}
	if firstValue+counts[span] > math.MaxUint32 {
		return 0, scratchFailed("The removal lists of the paged segment hold more values than its offsets reach",
			bucket.scratch.path, nil)
	}
	values := make([]byte, counts[span]*removalValueBytes)
	cursors := append([]uint64(nil), counts[:span]...)
	for at := 0; at < len(stored); at += removalTripleBytes {
		row := int(binary.LittleEndian.Uint32(stored[at:])) - first
		place := cursors[row] * removalValueBytes
		copy(values[place:place+2*removalValueBytes], stored[at+removalValueBytes:at+removalTripleBytes])
		cursors[row] += removalValuesPerTriple
	}
	offsets := make([]byte, 0, span*removalValueBytes)
	for at := range span {
		offsets = binary.LittleEndian.AppendUint32(offsets, uint32(firstValue+counts[at]))
	}
	if err := emit(offsets, values); err != nil {
		return 0, err
	}
	bucket.scratch.discard()
	return firstValue + counts[span], nil
}

func (spill *removalSpill) drain(emit func(offsets []byte, values []byte) error) error {
	next := uint64(0)
	for at, bucket := range spill.buckets {
		first := at * spill.ordinalsPerBucket
		end := max(first, min(spill.documentCount, first+spill.ordinalsPerBucket))
		drained, err := spill.drainBucket(bucket, first, end, next, emit)
		if err != nil {
			return err
		}
		next = drained
	}
	return emit(binary.LittleEndian.AppendUint32(nil, uint32(next)), nil)
}

func (spill *removalSpill) discard() {
	for _, bucket := range spill.buckets {
		bucket.scratch.discard()
	}
}
