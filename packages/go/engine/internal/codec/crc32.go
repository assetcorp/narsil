package codec

import (
	"hash/crc32"
	"sync"
)

const (
	crc32IEEEPolynomial uint32 = 0xEDB88320
	crc32AllBits        uint32 = 0xFFFFFFFF
	crc32Bits                  = 32
	crc32FirstDoublings        = 3
	crc32OperatorPowers        = 63
)

func CRC32(data []byte) uint32 {
	return crc32.ChecksumIEEE(data)
}

func CRC32Init() uint32 {
	return crc32AllBits
}

func CRC32Update(state uint32, data []byte) uint32 {
	return ^crc32.Update(^state, crc32.IEEETable, data)
}

func CRC32Final(state uint32) uint32 {
	return state ^ crc32AllBits
}

type crc32Operator [crc32Bits]uint32

func (operator *crc32Operator) times(vector uint32) uint32 {
	var sum uint32
	for row := 0; vector != 0; row, vector = row+1, vector>>1 {
		if vector&1 != 0 {
			sum ^= operator[row]
		}
	}
	return sum
}

func (operator *crc32Operator) squared() *crc32Operator {
	result := &crc32Operator{}
	for row := range result {
		result[row] = operator.times(operator[row])
	}
	return result
}

func buildZeroByteOperators() []*crc32Operator {
	oneZeroBit := &crc32Operator{}
	oneZeroBit[0] = crc32IEEEPolynomial
	for row := 1; row < crc32Bits; row++ {
		oneZeroBit[row] = 1 << (row - 1)
	}
	for range crc32FirstDoublings {
		oneZeroBit = oneZeroBit.squared()
	}
	operators := make([]*crc32Operator, 0, crc32OperatorPowers)
	operators = append(operators, oneZeroBit)
	for len(operators) < crc32OperatorPowers {
		operators = append(operators, operators[len(operators)-1].squared())
	}
	return operators
}

var zeroByteOperators = sync.OnceValue(buildZeroByteOperators)

func CRC32Combine(first uint32, second uint32, secondByteLength int64) uint32 {
	crc := first
	operators := zeroByteOperators()
	for power := 0; secondByteLength > 0 && power < len(operators); power, secondByteLength = power+1, secondByteLength/2 {
		if secondByteLength%2 == 1 {
			crc = operators[power].times(crc)
		}
	}
	return crc ^ second
}
