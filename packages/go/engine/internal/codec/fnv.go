package codec

const (
	FNVOffsetBasis uint32 = 2166136261
	FNVPrime       uint32 = 16777619
)

func FNV1aString(value string) uint32 {
	hash := FNVOffsetBasis
	for index := 0; index < len(value); index++ {
		hash = (hash ^ uint32(value[index])) * FNVPrime
	}
	return hash
}
