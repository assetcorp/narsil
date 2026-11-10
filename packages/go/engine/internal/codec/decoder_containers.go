package codec

func (decoder *Decoder) countAfterTag(tag byte, fixed byte, fixedLast byte, sixteen byte, thirtyTwo byte) (int, bool, error) {
	if tag >= fixed && tag <= fixedLast {
		return int(tag - fixed), true, nil
	}
	switch tag {
	case sixteen:
		count, err := decoder.readLength(2)
		return count, true, err
	case thirtyTwo:
		count, err := decoder.readLength(4)
		return count, true, err
	}
	return 0, false, nil
}

func (decoder *Decoder) readCount(fixed byte, fixedLast byte, sixteen byte, thirtyTwo byte, wanted string) (int, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return 0, err
	}
	count, matched, err := decoder.countAfterTag(tag, fixed, fixedLast, sixteen, thirtyTwo)
	if !matched {
		decoder.position--
		return 0, decoder.unexpected(tag, wanted)
	}
	return count, err
}

func (decoder *Decoder) ReadArrayCount() (int, error) {
	return decoder.readCount(tagFixarray, tagFixarrayLast, tagArray16, tagArray32, "an array")
}

func (decoder *Decoder) ReadMapCount() (int, error) {
	return decoder.readCount(tagFixmap, tagFixmapLast, tagMap16, tagMap32, "a map")
}

func (decoder *Decoder) ReadArrayHeader() (int, error) {
	count, err := decoder.ReadArrayCount()
	if err != nil {
		return 0, err
	}
	if count > decoder.Remaining() {
		return 0, decoder.insufficient()
	}
	return count, nil
}

func (decoder *Decoder) ReadMapHeader() (int, error) {
	count, err := decoder.ReadMapCount()
	if err != nil {
		return 0, err
	}
	if count > decoder.Remaining()/2 {
		return 0, decoder.insufficient()
	}
	return count, nil
}

func (decoder *Decoder) extensionSizeAfterTag(tag byte) (int, bool, error) {
	switch tag {
	case tagFixext1:
		return 1, true, nil
	case tagFixext2:
		return 2, true, nil
	case tagFixext4:
		return 4, true, nil
	case tagFixext8:
		return 8, true, nil
	case tagFixext16:
		return 16, true, nil
	case tagExt8:
		size, err := decoder.readLength(1)
		return size, true, err
	case tagExt16:
		size, err := decoder.readLength(2)
		return size, true, err
	case tagExt32:
		size, err := decoder.readLength(4)
		return size, true, err
	}
	return 0, false, nil
}

func (decoder *Decoder) readExtensionBody(size int) (int8, []byte, error) {
	header, err := decoder.take(1)
	if err != nil {
		return 0, nil, err
	}
	data, err := decoder.take(size)
	if err != nil {
		return 0, nil, err
	}
	return int8(header[0]), data, nil
}
