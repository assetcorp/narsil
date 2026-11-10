package codec

import "encoding/base64"

const (
	base64Padding           = '='
	base64CharactersInGroup = 4
	base64BytesInGroup      = 3
	base64InvalidSextet     = 0xFF
	base64SextetBits        = 6
)

var base64Sextets = buildBase64Sextets()

func buildBase64Sextets() [256]byte {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var sextets [256]byte
	for index := range sextets {
		sextets[index] = base64InvalidSextet
	}
	for index := 0; index < len(alphabet); index++ {
		sextets[alphabet[index]] = byte(index)
	}
	return sextets
}

func AppendBase64(destination []byte, bytes []byte) []byte {
	return base64.StdEncoding.AppendEncode(destination, bytes)
}

func EncodeBase64(bytes []byte) string {
	return base64.StdEncoding.EncodeToString(bytes)
}

func sextetsOf(group string) (uint32, bool) {
	var packed uint32
	for index := 0; index < len(group); index++ {
		sextet := base64Sextets[group[index]]
		if sextet == base64InvalidSextet {
			return 0, false
		}
		packed = packed<<base64SextetBits | uint32(sextet)
	}
	return packed, true
}

func DecodeExactBase64(encoded string) ([]byte, bool) {
	if len(encoded)%base64CharactersInGroup != 0 {
		return nil, false
	}
	padding := 0
	switch {
	case len(encoded) >= 2 && encoded[len(encoded)-2:] == "==":
		padding = 2
	case len(encoded) >= 1 && encoded[len(encoded)-1] == base64Padding:
		padding = 1
	}
	decoded := make([]byte, 0, len(encoded)/base64CharactersInGroup*base64BytesInGroup)
	fullEnd := len(encoded)
	if padding > 0 {
		fullEnd -= base64CharactersInGroup
	}
	for at := 0; at < fullEnd; at += base64CharactersInGroup {
		group, valid := sextetsOf(encoded[at : at+base64CharactersInGroup])
		if !valid {
			return nil, false
		}
		decoded = append(decoded, byte(group>>16), byte(group>>8), byte(group))
	}
	if padding == 0 {
		return decoded, true
	}
	group, valid := sextetsOf(encoded[fullEnd : fullEnd+base64CharactersInGroup-padding])
	if !valid {
		return nil, false
	}
	if padding == 2 {
		if group&0x0F != 0 {
			return nil, false
		}
		return append(decoded, byte(group>>4)), true
	}
	if group&0x03 != 0 {
		return nil, false
	}
	return append(decoded, byte(group>>10), byte(group>>2)), true
}
