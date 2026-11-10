package archive

import (
	"bytes"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const (
	BlockBytes = 512

	nameOffset          = 0
	nameBytes           = 100
	modeOffset          = 100
	ownerOffset         = 108
	groupOffset         = 116
	idFieldBytes        = 8
	sizeOffset          = 124
	sizeFieldBytes      = 12
	sizeFieldDigits     = 11
	mtimeOffset         = 136
	mtimeFieldBytes     = 12
	checksumFieldOffset = 148
	checksumFieldBytes  = 8
	checksumDigits      = 6
	typeflagOffset      = 156
	magicOffset         = 257
	magicFieldBytes     = 6
	versionOffset       = 263
	versionFieldBytes   = 2
	prefixOffset        = 345
	prefixBytes         = 155

	modeOctal   = "0000644"
	zeroOctal7  = "0000000"
	zeroOctal11 = "00000000000"
	ustarMagic  = "ustar"
	ustarVer    = "00"

	regularFile       byte = '0'
	oldRegularFile    byte = 0
	paxExtendedHeader byte = 'x'
	paxHeaderName          = "PaxHeader"

	maxSizeFieldValue = 0o77777777777
	checksumSpace     = 0x20
)

type tarHeader struct {
	name  string
	size  int64
	isPax bool
}

func invalidArchive(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceLoadFailed, "Invalid snapshot archive: "+message, details)
}

func saveFailed(message string, details map[string]any) error {
	return narsilerr.New(narsilerr.CodePersistenceSaveFailed, "The snapshot archive cannot be written: "+message, details)
}

func writeField(block []byte, offset int, length int, value string) {
	copy(block[offset:offset+length], value)
}

func headerChecksum(block []byte) int64 {
	var sum int64
	for at := range BlockBytes {
		if at >= checksumFieldOffset && at < checksumFieldOffset+checksumFieldBytes {
			sum += checksumSpace
			continue
		}
		sum += int64(block[at])
	}
	return sum
}

func paddedOctal(value int64, digits int) string {
	text := strconv.FormatInt(value, 8)
	if len(text) >= digits {
		return text
	}
	return strings.Repeat("0", digits-len(text)) + text
}

func ustarBlock(name string, prefix string, size int64, typeflag byte) []byte {
	block := make([]byte, BlockBytes)
	writeField(block, nameOffset, nameBytes, name)
	writeField(block, modeOffset, idFieldBytes, modeOctal)
	writeField(block, ownerOffset, idFieldBytes, zeroOctal7)
	writeField(block, groupOffset, idFieldBytes, zeroOctal7)
	writeField(block, sizeOffset, sizeFieldDigits, paddedOctal(size, sizeFieldDigits))
	writeField(block, mtimeOffset, mtimeFieldBytes, zeroOctal11)
	block[typeflagOffset] = typeflag
	writeField(block, magicOffset, magicFieldBytes, ustarMagic)
	writeField(block, versionOffset, versionFieldBytes, ustarVer)
	writeField(block, prefixOffset, prefixBytes, prefix)
	writeField(block, checksumFieldOffset, checksumDigits, paddedOctal(headerChecksum(block), checksumDigits))
	block[checksumFieldOffset+checksumDigits] = 0
	block[checksumFieldOffset+checksumDigits+1] = checksumSpace
	return block
}

func splitForUstar(name string) (string, string, bool) {
	if len(name) <= nameBytes {
		return name, "", true
	}
	for slash := strings.IndexByte(name, '/'); slash >= 0; {
		prefix := name[:slash]
		rest := name[slash+1:]
		if len(prefix) <= prefixBytes && len(rest) <= nameBytes {
			return rest, prefix, true
		}
		next := strings.IndexByte(name[slash+1:], '/')
		if next < 0 {
			break
		}
		slash += next + 1
	}
	return "", "", false
}

func paxRecord(key string, value string) []byte {
	body := " " + key + "=" + value + "\n"
	digits := 1
	for len(strconv.Itoa(len(body)+digits)) != digits {
		digits++
	}
	return []byte(strconv.Itoa(len(body)+digits) + body)
}

func paxFallbackName(name string) string {
	tail := name
	if len(tail) > nameBytes {
		tail = tail[len(tail)-nameBytes:]
	}
	if slash := strings.IndexByte(tail, '/'); slash >= 0 {
		tail = tail[slash+1:]
	}
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	return tail
}

func Padding(size int64) int64 {
	remainder := size % BlockBytes
	if remainder == 0 {
		return 0
	}
	return BlockBytes - remainder
}

func EntryHeaders(name string, size int64) ([][]byte, error) {
	if name == "" || strings.IndexByte(name, 0) >= 0 || !utf8.ValidString(name) {
		return nil, saveFailed("an entry name is empty, holds a NUL byte, or is not UTF-8", map[string]any{"entry": name})
	}
	if size < 0 || size > maxSizeFieldValue {
		return nil, saveFailed("an entry size does not fit the ustar size field", map[string]any{"entry": name, "bytes": size})
	}
	if short, prefix, fits := splitForUstar(name); fits {
		return [][]byte{ustarBlock(short, prefix, size, regularFile)}, nil
	}
	record := paxRecord("path", name)
	if len(record) > MaxPaxHeaderBytes {
		return nil, saveFailed("an entry name passes the pax header limit", map[string]any{"entry": name})
	}
	return [][]byte{
		ustarBlock(paxHeaderName, "", int64(len(record)), paxExtendedHeader),
		record,
		make([]byte, Padding(int64(len(record)))),
		ustarBlock(paxFallbackName(name), "", size, regularFile),
	}, nil
}

func EndBlocks() []byte {
	return make([]byte, BlockBytes*2)
}

func isZeroBlock(block []byte) bool {
	for _, value := range block {
		if value != 0 {
			return false
		}
	}
	return true
}

func readField(block []byte, offset int, length int) (string, error) {
	field := block[offset : offset+length]
	if end := bytes.IndexByte(field, 0); end >= 0 {
		field = field[:end]
	}
	if !utf8.Valid(field) {
		return "", invalidArchive("an entry header holds a name that is not UTF-8", nil)
	}
	return string(field), nil
}

func readOctal(block []byte, offset int, length int, what string) (int64, error) {
	text, err := readField(block, offset, length)
	if err != nil {
		return 0, err
	}
	text = strings.TrimSpace(text)
	invalid := invalidArchive("an entry header holds an invalid "+what, nil)
	if text == "" {
		return 0, invalid
	}
	for _, digit := range []byte(text) {
		if digit < '0' || digit > '7' {
			return 0, invalid
		}
	}
	value, parseErr := strconv.ParseInt(text, 8, 64)
	if parseErr != nil || value > form.MaxSafeInteger {
		return 0, invalid
	}
	return value, nil
}

func parseHeader(block []byte) (tarHeader, error) {
	checksum, err := readOctal(block, checksumFieldOffset, checksumFieldBytes, "checksum")
	if err != nil {
		return tarHeader{}, err
	}
	if checksum != headerChecksum(block) {
		return tarHeader{}, invalidArchive("an entry header fails its checksum", nil)
	}
	typeflag := block[typeflagOffset]
	if typeflag != regularFile && typeflag != oldRegularFile && typeflag != paxExtendedHeader {
		return tarHeader{}, invalidArchive("an entry has type "+strconv.QuoteRune(rune(typeflag))+
			", while an archive holds regular files alone", map[string]any{"typeflag": typeflag})
	}
	name, err := readField(block, nameOffset, nameBytes)
	if err != nil {
		return tarHeader{}, err
	}
	prefix, err := readField(block, prefixOffset, prefixBytes)
	if err != nil {
		return tarHeader{}, err
	}
	size, err := readOctal(block, sizeOffset, sizeFieldBytes, "size")
	if err != nil {
		return tarHeader{}, err
	}
	if prefix != "" {
		name = prefix + "/" + name
	}
	return tarHeader{name: name, size: size, isPax: typeflag == paxExtendedHeader}, nil
}

func parsePaxRecords(body []byte) (map[string]string, error) {
	records := map[string]string{}
	malformed := invalidArchive("a pax extended header holds a malformed record", nil)
	for at := 0; at < len(body); {
		space := bytes.IndexByte(body[at:], ' ')
		if space <= 0 {
			return nil, malformed
		}
		digits := body[at : at+space]
		for _, digit := range digits {
			if digit < '0' || digit > '9' {
				return nil, malformed
			}
		}
		length, err := strconv.Atoi(string(digits))
		if err != nil || length <= space || length > len(body)-at {
			return nil, malformed
		}
		record := body[at+space+1 : at+length]
		equals := bytes.IndexByte(record, '=')
		if equals < 0 || record[len(record)-1] != '\n' {
			return nil, invalidArchive("a pax extended header holds a record without a value", nil)
		}
		key, value := record[:equals], record[equals+1:len(record)-1]
		if !utf8.Valid(key) || !utf8.Valid(value) {
			return nil, invalidArchive("a pax extended header is not UTF-8", nil)
		}
		records[string(key)] = string(value)
		at += length
	}
	return records, nil
}
