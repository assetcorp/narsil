package cursor

const (
	base64Padding        = '='
	base64InvalidSextet  = 0xFF
	base64SextetCount    = 64
	base64GroupUnits     = 4
	base64GroupBytes     = 3
	base64PaddedMinUnits = 2
)

var lenientBase64Sextets = buildLenientBase64Sextets()

func buildLenientBase64Sextets() [256]byte {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var sextets [256]byte
	for index := range sextets {
		sextets[index] = base64InvalidSextet
	}
	for index := 0; index < len(alphabet); index++ {
		sextets[alphabet[index]] = byte(index)
	}
	sextets['-'] = 62
	sextets['_'] = 63
	return sextets
}

func sextetOfUnit(unit uint16) byte {
	return lenientBase64Sextets[byte(unit)]
}

func lenientDecodedSize(units []uint16) int {
	size := len(units)
	if size < base64PaddedMinUnits {
		return 0
	}
	if units[size-1] == base64Padding {
		size--
		if units[size-1] == base64Padding {
			size--
		}
	}
	if size < base64PaddedMinUnits {
		return 0
	}
	remainder := size % base64GroupUnits
	decoded := size / base64GroupUnits * base64GroupBytes
	if remainder == 0 {
		return decoded
	}
	if remainder == 3 {
		return decoded + 2
	}
	return decoded + 1
}

type lenientBase64Reader struct {
	units   []uint16
	at      int
	decoded []byte
}

func (reader *lenientBase64Reader) nextSextet() (byte, bool) {
	for {
		unit := reader.units[reader.at]
		sextet := sextetOfUnit(unit)
		reader.at++
		if sextet < base64SextetCount {
			return sextet, true
		}
		if byte(unit) == base64Padding || reader.at >= len(reader.units) {
			return 0, false
		}
	}
}

func (reader *lenientBase64Reader) slowGroup() bool {
	high, found := reader.nextSextet()
	if !found || reader.at >= len(reader.units) {
		return false
	}
	low, found := reader.nextSextet()
	if !found {
		return false
	}
	reader.decoded = append(reader.decoded, high<<2|(low&0x30)>>4)
	if reader.at >= len(reader.units) {
		return false
	}
	high = low
	if low, found = reader.nextSextet(); !found {
		return false
	}
	reader.decoded = append(reader.decoded, (high&0x0F)<<4|(low&0x3C)>>2)
	if reader.at >= len(reader.units) {
		return false
	}
	high = low
	if low, found = reader.nextSextet(); !found {
		return false
	}
	reader.decoded = append(reader.decoded, (high&0x03)<<6|low)
	return reader.at < len(reader.units)
}

func decodeLenientBase64(units []uint16) []byte {
	size := lenientDecodedSize(units)
	reader := lenientBase64Reader{units: units, decoded: make([]byte, 0, size+base64GroupBytes)}
	fastBytesEnd := size / base64GroupBytes * base64GroupBytes
	fastUnitsEnd := len(units) / base64GroupUnits * base64GroupUnits
	for reader.at < fastUnitsEnd && len(reader.decoded) < fastBytesEnd {
		first := sextetOfUnit(units[reader.at])
		second := sextetOfUnit(units[reader.at+1])
		third := sextetOfUnit(units[reader.at+2])
		fourth := sextetOfUnit(units[reader.at+3])
		if first|second|third|fourth >= base64SextetCount {
			if !reader.slowGroup() {
				return reader.decoded
			}
			fastUnitsEnd = reader.at + (len(units)-reader.at)/base64GroupUnits*base64GroupUnits
			continue
		}
		reader.decoded = append(reader.decoded, first<<2|second>>4, second<<4|third>>2, third<<6|fourth)
		reader.at += base64GroupUnits
	}
	if reader.at < len(units) {
		reader.slowGroup()
	}
	return reader.decoded
}
