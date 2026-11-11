package cursor

import "github.com/assetcorp/narsil/packages/go/engine/internal/model"

func boundFiltersOf(filters *model.FilterExpression) boundValue {
	if filters == nil {
		return absentValue()
	}
	return boundExpressionOf(*filters)
}

func boundExpressionOf(expression model.FilterExpression) boundValue {
	var builder boundMapBuilder
	if expression.Fields != nil {
		var fields boundMapBuilder
		for path, filter := range expression.Fields {
			fields.put(path, boundFieldFilterOf(filter))
		}
		builder.put("fields", fields.value())
	}
	builder.put("and", boundExpressionList(expression.And))
	builder.put("or", boundExpressionList(expression.Or))
	builder.put("not", boundFiltersOf(expression.Not))
	return builder.value()
}

func boundExpressionList(expressions []model.FilterExpression) boundValue {
	if expressions == nil {
		return absentValue()
	}
	members := make([]boundValue, len(expressions))
	for index, expression := range expressions {
		members[index] = boundExpressionOf(expression)
	}
	return listValue(members)
}

func boundFilterValueOf(value model.FilterValue) boundValue {
	if number, isNumber := value.Number(); isNumber {
		return numberValue(number)
	}
	if text, isText := value.Text(); isText {
		return stringValue(text)
	}
	if boolean, isBoolean := value.Boolean(); isBoolean {
		return booleanValue(boolean)
	}
	return absentValue()
}

func boundFilterValueList(values []model.FilterValue) boundValue {
	if values == nil {
		return absentValue()
	}
	members := make([]boundValue, len(values))
	for index, value := range values {
		members[index] = boundFilterValueOf(value)
	}
	return listValue(members)
}

func boundRangeBoundOf(bound model.RangeBound) boundValue {
	if number, isNumber := bound.Number(); isNumber {
		return numberValue(number)
	}
	if text, isText := bound.Text(); isText {
		return stringValue(text)
	}
	return absentValue()
}

func boundIntervalOf(interval model.RangeInterval) boundValue {
	if !interval.IsSet() {
		return absentValue()
	}
	return listValue([]boundValue{boundRangeBoundOf(interval.Low), boundRangeBoundOf(interval.High)})
}

func boundToleranceOf(tolerance model.PatternTolerance) boundValue {
	if edits, isEdits := tolerance.Edits(); isEdits {
		return numberValue(float64(edits))
	}
	if tolerance.Kind() == model.PatternToleranceAuto {
		return stringValue(boundToleranceAuto)
	}
	return absentValue()
}

func boundSizeOf(size *model.SizeFilter) boundValue {
	if size == nil {
		return absentValue()
	}
	var builder boundMapBuilder
	builder.put("eq", optionalNumber(size.Eq))
	builder.put("ne", optionalNumber(size.Ne))
	builder.put("gt", optionalNumber(size.Gt))
	builder.put("lt", optionalNumber(size.Lt))
	builder.put("gte", optionalNumber(size.Gte))
	builder.put("lte", optionalNumber(size.Lte))
	if interval, set := size.Between.Get(); set {
		builder.put("between", listValue([]boundValue{numberValue(interval.Low), numberValue(interval.High)}))
	}
	return builder.value()
}

func boundRadiusOf(radius *model.GeoRadius) boundValue {
	if radius == nil {
		return absentValue()
	}
	var builder boundMapBuilder
	builder.put("lat", numberValue(radius.Lat))
	builder.put("lon", numberValue(radius.Lon))
	builder.put("distance", numberValue(radius.Distance))
	builder.put("unit", nonEmptyString(string(radius.Unit)))
	builder.put("inside", optionalBoolean(radius.Inside))
	builder.put("highPrecision", trueWhenSet(radius.HighPrecision))
	return builder.value()
}

func boundPolygonOf(polygon *model.GeoPolygon) boundValue {
	if polygon == nil {
		return absentValue()
	}
	var builder boundMapBuilder
	if polygon.Points != nil {
		points := make([]boundValue, len(polygon.Points))
		for index, point := range polygon.Points {
			var corner boundMapBuilder
			corner.put("lat", numberValue(point.Lat))
			corner.put("lon", numberValue(point.Lon))
			points[index] = corner.value()
		}
		builder.put("points", listValue(points))
	}
	builder.put("inside", optionalBoolean(polygon.Inside))
	return builder.value()
}

func boundFieldFilterOf(filter model.FieldFilter) boundValue {
	var builder boundMapBuilder
	builder.put("eq", boundFilterValueOf(filter.Eq))
	builder.put("ne", boundFilterValueOf(filter.Ne))
	builder.put("gt", boundRangeBoundOf(filter.Gt))
	builder.put("lt", boundRangeBoundOf(filter.Lt))
	builder.put("gte", boundRangeBoundOf(filter.Gte))
	builder.put("lte", boundRangeBoundOf(filter.Lte))
	builder.put("between", boundIntervalOf(filter.Between))
	builder.put("in", stringList(filter.In))
	builder.put("nin", stringList(filter.Nin))
	builder.put("startsWith", optionalString(filter.StartsWith))
	builder.put("endsWith", optionalString(filter.EndsWith))
	builder.put("contains", optionalString(filter.Contains))
	builder.put("wildcard", optionalString(filter.Wildcard))
	builder.put("regex", optionalString(filter.Regex))
	builder.put("caseFold", trueWhenSet(filter.CaseFold))
	builder.put("tolerance", boundToleranceOf(filter.Tolerance))
	builder.put("containsAll", boundFilterValueList(filter.ContainsAll))
	builder.put("matchesAny", boundFilterValueList(filter.MatchesAny))
	builder.put("size", boundSizeOf(filter.Size))
	builder.put("exists", optionalBoolean(filter.Exists))
	builder.put("notExists", optionalBoolean(filter.NotExists))
	builder.put("isEmpty", optionalBoolean(filter.IsEmpty))
	builder.put("isNotEmpty", optionalBoolean(filter.IsNotEmpty))
	builder.put("radius", boundRadiusOf(filter.Radius))
	builder.put("polygon", boundPolygonOf(filter.Polygon))
	return builder.value()
}
