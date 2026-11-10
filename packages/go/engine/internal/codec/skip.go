package codec

func (decoder *Decoder) skipOne() (int, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return 0, err
	}
	switch typeOfTag(tag) {
	case TypeNil, TypeBoolean:
		return 0, nil
	case TypeInteger, TypeFloat:
		_, err := decoder.take(numberWidth(tag))
		return 0, err
	case TypeString:
		length, _, err := decoder.stringLengthAfterTag(tag)
		if err == nil {
			_, err = decoder.take(length)
		}
		return 0, err
	case TypeBinary:
		length, _, err := decoder.binaryLengthAfterTag(tag)
		if err == nil {
			_, err = decoder.take(length)
		}
		return 0, err
	case TypeExtension:
		size, _, err := decoder.extensionSizeAfterTag(tag)
		if err == nil {
			_, err = decoder.take(size + 1)
		}
		return 0, err
	case TypeArray:
		count, _, err := decoder.countAfterTag(tag, tagFixarray, tagFixarrayLast, tagArray16, tagArray32)
		if err == nil && count > decoder.Remaining() {
			err = decoder.insufficient()
		}
		return count, err
	case TypeMap:
		count, _, err := decoder.countAfterTag(tag, tagFixmap, tagFixmapLast, tagMap16, tagMap32)
		if err == nil && count > decoder.Remaining()/2 {
			err = decoder.insufficient()
		}
		return count * 2, err
	}
	decoder.position--
	return 0, decoder.Errorf("Unrecognized type byte: 0x%02x", tag)
}

func (decoder *Decoder) Skip() error {
	pending := 1
	for pending > 0 {
		children, err := decoder.skipOne()
		if err != nil {
			return err
		}
		pending += children - 1
		if pending > decoder.Remaining() {
			return decoder.insufficient()
		}
	}
	return nil
}

func (decoder *Decoder) ReadRaw() ([]byte, error) {
	start := decoder.position
	if err := decoder.Skip(); err != nil {
		return nil, err
	}
	return decoder.data[start:decoder.position:decoder.position], nil
}
