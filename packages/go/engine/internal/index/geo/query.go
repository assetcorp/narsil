package geo

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/index/bitset"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (index *Index) RadiusQuery(lat, lon, distanceMetres float64, inside, highPrecision bool, into bitset.Bits) {
	prepare := func() locationTest { return radiusCandidateTest(lat, lon, distanceMetres, highPrecision) }
	index.matching(radiusBoxes(lat, lon, distanceMetres), prepare, inside, into)
}

func (index *Index) PolygonQuery(points []model.GeoPoint, inside bool, into bitset.Bits) {
	contains := polygonContainment(points)
	index.matching(polygonBoxes(points), func() locationTest { return contains }, inside, into)
}

type candidateMatcher struct {
	prepare func() locationTest
	passes  locationTest
}

func (matcher *candidateMatcher) matches(row *locationRow) bool {
	if matcher.passes == nil {
		matcher.passes = matcher.prepare()
	}
	return matcher.passes(row.lat, row.lon)
}

func (index *Index) matching(boxes []locationBox, prepare func() locationTest, inside bool, into bitset.Bits) {
	ranges := coveringRanges(boxes)
	matcher := &candidateMatcher{prepare: prepare}
	if inside {
		index.matchLocatedInside(ranges, matcher, into)
	} else {
		index.matchLocatedOutside(ranges, matcher, into)
	}
	for at := range index.pending {
		row := &index.pending[at]
		if row.removed {
			continue
		}
		within := rangesHold(ranges, row.code) && matcher.matches(row)
		if within == inside {
			into.Set(row.ordinal)
		}
	}
}

func (index *Index) matchLocatedInside(ranges []codeRange, matcher *candidateMatcher, into bitset.Bits) {
	rows := index.located
	for _, span := range ranges {
		for at := firstAtOrAfter(rows, span.from); at < len(rows) && rows[at].code < span.to; at++ {
			row := &rows[at]
			if !row.removed && matcher.matches(row) {
				into.Set(row.ordinal)
			}
		}
	}
}

func (index *Index) matchLocatedOutside(ranges []codeRange, matcher *candidateMatcher, into bitset.Bits) {
	rows := index.located
	next := 0
	for at := range rows {
		row := &rows[at]
		if row.removed {
			continue
		}
		for next < len(ranges) && ranges[next].to <= row.code {
			next++
		}
		within := next < len(ranges) && ranges[next].from <= row.code && matcher.matches(row)
		if !within {
			into.Set(row.ordinal)
		}
	}
}
