package codec

import (
	"slices"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

type decodeMode uint8

const (
	exactDecoding decodeMode = iota
	javaScriptDecoding
)

const forbiddenMapKey = "__proto__"

func (decoder *Decoder) ReadValue() (any, error) {
	return decoder.readValue(1, exactDecoding)
}

func (decoder *Decoder) ReadValueAsJavaScript() (any, error) {
	return decoder.readValue(1, javaScriptDecoding)
}

func (decoder *Decoder) readValue(depth int, mode decodeMode) (any, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return nil, err
	}
	valueType := typeOfTag(tag)
	if (valueType == TypeArray || valueType == TypeMap) && depth > decoder.maxDepth {
		decoder.position--
		return nil, decoder.Errorf("the value nests deeper than %d levels", decoder.maxDepth)
	}
	switch valueType {
	case TypeNil:
		return nil, nil
	case TypeBoolean:
		return tag == tagTrue, nil
	case TypeInteger, TypeFloat:
		number, _, err := decoder.readNumberAfterTag(tag)
		return number, err
	case TypeString:
		return decoder.readStringAfterTag(tag)
	case TypeBinary:
		length, _, err := decoder.binaryLengthAfterTag(tag)
		if err != nil {
			return nil, err
		}
		bytes, err := decoder.take(length)
		if err != nil {
			return nil, err
		}
		return decoder.ownedBytes(bytes), nil
	case TypeArray:
		count, _, err := decoder.countAfterTag(tag, tagFixarray, tagFixarrayLast, tagArray16, tagArray32)
		if err != nil {
			return nil, err
		}
		return decoder.readList(count, depth, mode)
	case TypeMap:
		count, _, err := decoder.countAfterTag(tag, tagFixmap, tagFixmapLast, tagMap16, tagMap32)
		if err != nil {
			return nil, err
		}
		if mode == javaScriptDecoding {
			return decoder.readOrderedMap(count, depth)
		}
		return decoder.readMap(count, depth)
	case TypeExtension:
		size, _, err := decoder.extensionSizeAfterTag(tag)
		if err != nil {
			return nil, err
		}
		return decoder.readExtensionValue(size, mode)
	}
	decoder.position--
	return nil, decoder.Errorf("Unrecognized type byte: 0x%02x", tag)
}

func (decoder *Decoder) readStringAfterTag(tag byte) (string, error) {
	length, _, err := decoder.stringLengthAfterTag(tag)
	if err != nil {
		return "", err
	}
	bytes, err := decoder.take(length)
	if err != nil {
		return "", err
	}
	return text.DecodeUTF8(bytes), nil
}

func (decoder *Decoder) readList(count int, depth int, mode decodeMode) ([]any, error) {
	if count > decoder.Remaining() {
		return nil, decoder.insufficient()
	}
	list := make([]any, 0, min(count, decodePreallocatedEntries))
	for range count {
		if len(list) == cap(list) {
			list = slices.Grow(list, min(count-len(list), len(list)))
		}
		element, err := decoder.readValue(depth+1, mode)
		if err != nil {
			return nil, err
		}
		list = append(list, element)
	}
	return list, nil
}

func (decoder *Decoder) readMapKey() (string, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return "", err
	}
	switch typeOfTag(tag) {
	case TypeString:
		key, err := decoder.readStringAfterTag(tag)
		if err != nil {
			return "", err
		}
		if key == forbiddenMapKey {
			return "", decoder.Errorf("The key __proto__ is not allowed")
		}
		return key, nil
	case TypeInteger, TypeFloat:
		number, _, err := decoder.readNumberAfterTag(tag)
		if err != nil {
			return "", err
		}
		return text.FormatNumber(number), nil
	case TypeBoolean:
		return "", decoder.Errorf("The type of key must be string or number but boolean")
	case TypeInvalid:
		decoder.position--
		return "", decoder.Errorf("Unrecognized type byte: 0x%02x", tag)
	}
	return "", decoder.Errorf("The type of key must be string or number but object")
}

func (decoder *Decoder) readMap(count int, depth int) (map[string]any, error) {
	if count > decoder.Remaining()/2 {
		return nil, decoder.insufficient()
	}
	record := make(map[string]any, min(count, decodePreallocatedEntries))
	for range count {
		key, err := decoder.readMapKey()
		if err != nil {
			return nil, err
		}
		value, err := decoder.readValue(depth+1, exactDecoding)
		if err != nil {
			return nil, err
		}
		record[key] = value
	}
	return record, nil
}

func (decoder *Decoder) readOrderedMap(count int, depth int) (OrderedMap, error) {
	if count > decoder.Remaining()/2 {
		return nil, decoder.insufficient()
	}
	entries := make(OrderedMap, 0, min(count, decodePreallocatedEntries))
	positions := make(map[string]int, min(count, decodePreallocatedEntries))
	for range count {
		key, err := decoder.readMapKey()
		if err != nil {
			return nil, err
		}
		value, err := decoder.readValue(depth+1, javaScriptDecoding)
		if err != nil {
			return nil, err
		}
		if position, seen := positions[key]; seen {
			entries[position].Value = value
			continue
		}
		positions[key] = len(entries)
		entries = append(entries, MapEntry{Key: key, Value: value})
	}
	return inJavaScriptPropertyOrder(entries), nil
}

func inJavaScriptPropertyOrder(entries OrderedMap) OrderedMap {
	indexCount := 0
	for _, entry := range entries {
		if _, isIndex := arrayIndexOf(entry.Key); isIndex {
			indexCount++
		}
	}
	if indexCount == 0 {
		return entries
	}
	ordered := make(OrderedMap, 0, len(entries))
	for _, entry := range entries {
		if _, isIndex := arrayIndexOf(entry.Key); isIndex {
			ordered = append(ordered, entry)
		}
	}
	slices.SortFunc(ordered, func(left, right MapEntry) int {
		return compareObjectKeys(left.Key, right.Key)
	})
	for _, entry := range entries {
		if _, isIndex := arrayIndexOf(entry.Key); !isIndex {
			ordered = append(ordered, entry)
		}
	}
	return ordered
}

func (decoder *Decoder) readExtensionValue(size int, mode decodeMode) (any, error) {
	extensionType, data, err := decoder.readExtensionBody(size)
	if err != nil {
		return nil, err
	}
	if extensionType != TimestampExtensionType {
		return Extension{Type: extensionType, Data: decoder.ownedBytes(data)}, nil
	}
	parts, recognised := decodeTimestampParts(data)
	if !recognised {
		return nil, decoder.Errorf("Unrecognized data size for timestamp (expected 4, 8, or 12): %d", len(data))
	}
	if mode == javaScriptDecoding {
		milliseconds, valid := parts.javaScriptMilliseconds()
		if !valid {
			return InvalidDate{}, nil
		}
		return time.UnixMilli(int64(milliseconds)), nil
	}
	moment, valid := parts.exactTime()
	if !valid {
		return nil, decoder.Errorf("the timestamp's seconds lie outside -%d to %d", maxSafeInteger, maxSafeInteger)
	}
	return moment, nil
}

func (decoder *Decoder) requireEnd() error {
	if decoder.More() {
		return decoder.Errorf("Extra %d of %d byte(s) found at buffer[%d]", decoder.Remaining(), len(decoder.data), decoder.position)
	}
	return nil
}

func Unmarshal(data []byte, options DecodeOptions) (any, error) {
	decoder := NewDecoder(data, options)
	value, err := decoder.ReadValue()
	if err != nil {
		return nil, err
	}
	return value, decoder.requireEnd()
}

func UnmarshalAsJavaScript(data []byte, options DecodeOptions) (any, error) {
	decoder := NewDecoder(data, options)
	value, err := decoder.ReadValueAsJavaScript()
	if err != nil {
		return nil, err
	}
	return value, decoder.requireEnd()
}

func DecodeDocument(data []byte, options DecodeOptions) (map[string]any, error) {
	decoder := NewDecoder(data, options)
	tag, err := decoder.peekTag()
	if err != nil {
		return nil, err
	}
	if typeOfTag(tag) != TypeMap {
		return nil, decoder.Errorf("a document must be a map, but found type byte 0x%02x", tag)
	}
	value, err := decoder.ReadValue()
	if err != nil {
		return nil, err
	}
	if err := decoder.requireEnd(); err != nil {
		return nil, err
	}
	document, _ := value.(map[string]any)
	return document, nil
}

func AppendReencoded(destination []byte, encoded []byte, encodeOptions EncodeOptions, decodeOptions DecodeOptions) ([]byte, error) {
	value, err := UnmarshalAsJavaScript(encoded, decodeOptions)
	if err != nil {
		return destination, err
	}
	return AppendValue(destination, value, encodeOptions)
}
