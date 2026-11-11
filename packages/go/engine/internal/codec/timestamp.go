package codec

import (
	"encoding/binary"
	"math"
	"time"
)

const (
	TimestampExtensionType      int8 = -1
	timestampExtensionTypeByte  byte = 0xFF
	timestamp32MaxSeconds            = 1<<32 - 1
	timestamp64MaxSeconds            = 1<<34 - 1
	timestamp32Bytes                 = 4
	timestamp64Bytes                 = 8
	timestamp96Bytes                 = 12
	timestamp64SecondsHighMask       = 0x3
	timestamp64NanosecondsShift      = 2
	twoToThe32                       = 4294967296.0
	maxSafeInteger                   = 9007199254740991
	maxDateMilliseconds              = 8.64e15
	maxTimestampNanoseconds          = 999_999_999
	millisecondsPerSecond            = 1_000
	nanosecondsPerMillisecond        = 1_000_000
)

type timestampParts struct {
	seconds          int64
	nanoseconds      uint32
	secondsAsNumber  float64
	nanosecondsFloat float64
}

func AppendTimestamp(destination []byte, moment time.Time) []byte {
	return appendTimestampParts(destination, moment.Unix(), uint32(moment.Nanosecond()))
}

func appendTimestampParts(destination []byte, seconds int64, nanoseconds uint32) []byte {
	if seconds >= 0 && seconds <= timestamp64MaxSeconds {
		if nanoseconds == 0 && seconds <= timestamp32MaxSeconds {
			destination = append(destination, tagFixext4, timestampExtensionTypeByte)
			return appendUint32(destination, uint32(seconds))
		}
		destination = append(destination, tagFixext8, timestampExtensionTypeByte)
		destination = appendUint32(destination, nanoseconds<<timestamp64NanosecondsShift|uint32(seconds>>32)&timestamp64SecondsHighMask)
		return appendUint32(destination, uint32(seconds))
	}
	destination = append(destination, tagExt8, timestamp96Bytes, timestampExtensionTypeByte)
	destination = appendUint32(destination, nanoseconds)
	return appendUint64(destination, uint64(seconds))
}

func AppendInvalidDate(destination []byte) []byte {
	destination = append(destination, tagExt8, timestamp96Bytes, timestampExtensionTypeByte)
	return append(destination, make([]byte, timestamp96Bytes)...)
}

func decodeTimestampParts(data []byte) (timestampParts, bool) {
	switch len(data) {
	case timestamp32Bytes:
		seconds := binary.BigEndian.Uint32(data)
		return timestampParts{seconds: int64(seconds), secondsAsNumber: float64(seconds)}, true
	case timestamp64Bytes:
		packed := binary.BigEndian.Uint32(data)
		low := binary.BigEndian.Uint32(data[4:])
		seconds := int64(packed&timestamp64SecondsHighMask)<<32 | int64(low)
		nanoseconds := packed >> timestamp64NanosecondsShift
		return timestampParts{
			seconds:          seconds,
			nanoseconds:      nanoseconds,
			secondsAsNumber:  float64(seconds),
			nanosecondsFloat: float64(nanoseconds),
		}, true
	case timestamp96Bytes:
		nanoseconds := binary.BigEndian.Uint32(data)
		high := int32(binary.BigEndian.Uint32(data[4:]))
		low := binary.BigEndian.Uint32(data[8:])
		return timestampParts{
			seconds:          int64(binary.BigEndian.Uint64(data[4:])),
			nanoseconds:      nanoseconds,
			secondsAsNumber:  float64(float64(high)*twoToThe32) + float64(low),
			nanosecondsFloat: float64(nanoseconds),
		}, true
	}
	return timestampParts{}, false
}

func (parts timestampParts) javaScriptMilliseconds() (float64, bool) {
	milliseconds := float64(parts.secondsAsNumber*millisecondsPerSecond) + parts.nanosecondsFloat/nanosecondsPerMillisecond
	if math.IsNaN(milliseconds) || math.Abs(milliseconds) > maxDateMilliseconds {
		return 0, false
	}
	return math.Trunc(milliseconds), true
}

func (parts timestampParts) exactTime() (time.Time, bool) {
	if parts.seconds > maxSafeInteger || parts.seconds < -maxSafeInteger {
		return time.Time{}, false
	}
	return time.Unix(parts.seconds, int64(parts.nanoseconds)), true
}
