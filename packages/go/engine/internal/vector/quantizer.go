package vector

import (
	"context"
	"math"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

type calibrationState struct {
	count            int
	counted          bool
	meanLength       float64
	meanLengthKnown  bool
	nextDriftCheckAt float64
}

func noCalibration() calibrationState {
	return calibrationState{nextDriftCheckAt: math.Inf(1)}
}

type liveVectorMean struct {
	centroid   []float32
	mean       []float64
	meanLength float64
	count      int
	spread     float64
}

func (f *Field) quantises() bool {
	return f.config.bits != 0
}

func (f *Field) calibrated() bool {
	return f.quantises() && f.store.calibrated()
}

func withWorkspace(work func(workspace *core.Workspace) error) error {
	workspace, err := core.AcquireWorkspace()
	if err != nil {
		return coreFailure("workspaceCreate", err)
	}
	defer workspace.Release()
	return work(workspace)
}

func (f *Field) nativeStore() *core.Store {
	return f.writerLayout().native
}

func (f *Field) measureInto(ctx context.Context, ordinals []int32, totals []float64) error {
	return withWorkspace(func(workspace *core.Workspace) error {
		for start := 0; start < len(ordinals); start += recalibrationChunkVectors {
			if err := ctx.Err(); err != nil {
				return err
			}
			end := min(len(ordinals), start+recalibrationChunkVectors)
			if err := workspace.Measure(f.nativeStore(), f.config.nativeMetric, ordinals[start:end], totals); err != nil {
				return coreFailure("measure", err)
			}
		}
		return nil
	})
}

func meanOfTotals(totals []float64, dimension int) []float64 {
	count := totals[dimension+1]
	mean := make([]float64, dimension)
	for index := range mean {
		mean[index] = totals[index] / count
	}
	return mean
}

func centroidOfTotals(totals []float64, dimension int, metric model.VectorMetric) []float32 {
	if totals[dimension+1] == 0 {
		return nil
	}
	mean := meanOfTotals(totals, dimension)
	centroid := make([]float32, dimension)
	if metric != model.MetricCosine {
		for index, value := range mean {
			centroid[index] = float32(value)
		}
		return centroid
	}
	squares := 0.0
	for _, value := range mean {
		squares += float64(value * value)
	}
	length := math.Sqrt(squares)
	for index, value := range mean {
		if length == 0 {
			centroid[index] = float32(value)
			continue
		}
		centroid[index] = float32(value / length)
	}
	return centroid
}

func liveMeanOfTotals(totals []float64, dimension int, metric model.VectorMetric) *liveVectorMean {
	centroid := centroidOfTotals(totals, dimension, metric)
	if centroid == nil {
		return nil
	}
	mean := meanOfTotals(totals, dimension)
	count := totals[dimension+1]
	meanSquares := 0.0
	for _, value := range mean {
		meanSquares += float64(value * value)
	}
	return &liveVectorMean{
		centroid:   centroid,
		mean:       mean,
		meanLength: math.Sqrt(meanSquares),
		count:      int(count),
		spread:     math.Sqrt(math.Max(0, totals[dimension]/count-meanSquares)),
	}
}

func (f *Field) measureLiveVectors(ctx context.Context) (*liveVectorMean, error) {
	totals := make([]float64, f.config.dimension+2)
	if err := f.measureInto(ctx, f.liveOrdinals(), totals); err != nil {
		return nil, err
	}
	return liveMeanOfTotals(totals, f.config.dimension, f.config.metric), nil
}

func (f *Field) writeCentroid(centroid []float32) {
	copy(f.store.centroidValues(), centroid)
	f.store.word(core.StoreWordCalibrationGeneration).Add(1)
	f.store.word(core.StoreWordCalibrated).Store(1)
}

func (f *Field) calibrateFrom(ctx context.Context, ordinals []int32) (bool, error) {
	totals := make([]float64, f.config.dimension+2)
	if err := f.measureInto(ctx, ordinals, totals); err != nil {
		return false, err
	}
	centroid := centroidOfTotals(totals, f.config.dimension, f.config.metric)
	if centroid == nil {
		return false, nil
	}
	f.writeCentroid(centroid)
	return true, nil
}

func (f *Field) writeCodesOf(ordinals []int32) error {
	if !f.calibrated() || len(ordinals) == 0 {
		return nil
	}
	return withWorkspace(func(workspace *core.Workspace) error {
		if err := workspace.Quantise(f.nativeStore(), f.config.nativeMetric, ordinals); err != nil {
			return coreFailure("quantise", err)
		}
		return nil
	})
}

func (f *Field) clearCodes(ordinal int32) {
	if !f.quantises() || ordinal < 0 || uintptr(ordinal) >= f.store.head.codePresent.length {
		return
	}
	present := f.store.head.codePresent.pointer()
	if loadByte(present, int(ordinal)) != 1 {
		return
	}
	storeByte(present, int(ordinal), 0)
	f.store.word(core.StoreWordCodeCount).Add(-1)
}

func (f *Field) resetCodes() {
	if !f.quantises() {
		return
	}
	clear(bytesAt(f.store.head.codePresent.pointer(), f.store.head.codePresent.length))
	f.store.word(core.StoreWordCodeCount).Store(0)
}

func (f *Field) resetCalibration() {
	if !f.quantises() {
		return
	}
	f.store.word(core.StoreWordCalibrated).Store(0)
	clear(f.store.centroidValues())
	f.store.word(core.StoreWordCalibrationGeneration).Add(1)
}

func (f *Field) clearQuantizer() {
	f.resetCodes()
	f.resetCalibration()
}

func (f *Field) recalibrateInPlace(ctx context.Context, ordinals []int32) error {
	if !f.quantises() || len(ordinals) == 0 {
		return nil
	}
	f.resetCodes()
	if _, err := f.calibrateFrom(ctx, ordinals); err != nil {
		return err
	}
	return f.writeCodesOf(ordinals)
}

func (f *Field) forgetCalibration() {
	f.calibration = noCalibration()
}

func nextDriftCheck(calibratedCount, held int) float64 {
	next := float64(max(1, calibratedCount) * driftCheckGrowthFactor)
	for next <= float64(held) {
		next *= driftCheckGrowthFactor
	}
	return next
}

func (f *Field) noteCalibration(live *liveVectorMean) {
	f.calibration.count = live.count
	f.calibration.counted = true
	f.calibration.meanLengthKnown = f.config.metric == model.MetricCosine
	f.calibration.meanLength = live.meanLength
	f.calibration.nextDriftCheckAt = nextDriftCheck(live.count, live.count)
}

func (f *Field) adoptLoadedCalibration(calibratedCount int, meanLength float64, meanLengthKnown bool) {
	if !f.calibrated() {
		return
	}
	f.calibration.count = calibratedCount
	f.calibration.counted = true
	f.calibration.meanLength = meanLength
	f.calibration.meanLengthKnown = meanLengthKnown
	f.calibration.nextDriftCheckAt = float64(max(1, calibratedCount) * driftCheckGrowthFactor)
}

func (f *Field) recalibrateFromStore(ctx context.Context) error {
	if !f.quantises() {
		return nil
	}
	ordinals := f.liveOrdinals()
	if err := f.recalibrateInPlace(ctx, ordinals); err != nil {
		return err
	}
	f.calibration.count = len(ordinals)
	f.calibration.counted = true
	f.calibration.meanLengthKnown = false
	f.calibration.nextDriftCheckAt = float64(max(1, len(ordinals)) * driftCheckGrowthFactor)
	return nil
}

func driftRatio(live *liveVectorMean, calibrated []float32, calibratedCount int, meanLength float64,
	meanLengthKnown bool, metric model.VectorMetric) float64 {
	if calibratedCount <= 0 || live.count <= calibratedCount {
		return 0
	}
	scale := 1.0
	if metric == model.MetricCosine {
		scale = live.meanLength
		if meanLengthKnown {
			scale = meanLength
		}
	}
	squares := 0.0
	for index, value := range live.mean {
		difference := value - float64(float64(calibrated[index])*scale)
		squares += float64(difference * difference)
	}
	expected := float64(live.spread * math.Sqrt(1/float64(calibratedCount)-1/float64(live.count)))
	if expected == 0 {
		if squares == 0 {
			return 0
		}
		return math.Inf(1)
	}
	return math.Sqrt(squares) / expected
}
