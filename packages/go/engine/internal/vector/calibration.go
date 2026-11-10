package vector

import "context"

func (f *Field) calibrateFromLiveVectorsLocked(ctx context.Context, live *liveVectorMean) (bool, error) {
	if !f.quantises() || f.disposed {
		return false, nil
	}
	if f.calibrated() {
		if err := f.recodeEveryVector(ctx, live); err != nil {
			return false, err
		}
		f.revision.Add(1)
	} else {
		f.writeCentroid(live.centroid)
	}
	f.noteCalibration(live)
	return true, nil
}

func (f *Field) calibrateBeforeBuild(ctx context.Context) (bool, error) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	return f.calibrateBeforeBuildLocked(ctx)
}

func (f *Field) calibrateBeforeBuildLocked(ctx context.Context) (bool, error) {
	if !f.quantises() {
		return true, nil
	}
	if f.disposed {
		return false, nil
	}
	live, err := f.measureLiveVectors(ctx)
	if err != nil || live == nil {
		return false, err
	}
	return f.calibrateFromLiveVectorsLocked(ctx, live)
}

func (f *Field) recalibrateWhenDrifted(ctx context.Context, held int) (bool, error) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if !f.quantises() || float64(held) < f.calibration.nextDriftCheckAt || f.disposed {
		return false, nil
	}
	live, err := f.measureLiveVectors(ctx)
	if err != nil || live == nil {
		return false, err
	}
	if f.calibrated() && f.calibration.counted {
		centroid := append([]float32(nil), f.store.centroidValues()...)
		ratio := driftRatio(live, centroid, f.calibration.count, f.calibration.meanLength,
			f.calibration.meanLengthKnown, f.config.metric)
		if ratio <= recalibrationDriftRatio {
			f.calibration.nextDriftCheckAt = nextDriftCheck(f.calibration.count, live.count)
			return false, nil
		}
	}
	return f.calibrateFromLiveVectorsLocked(ctx, live)
}
