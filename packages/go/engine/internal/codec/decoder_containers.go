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

func (decoder *Decoder) ReadArrayHeader() (int, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return 0, err
	}
	count, isArray, err := decoder.countAfterTag(tag, tagFixarray, tagFixarrayLast, tagArray16, tagArray32)
	if !isArray {
		decoder.position--
		return 0, decoder.unexpected(tag, "an array")
	}
	if err != nil {
		return 0, err
	}
	if count > decoder.Remaining() {
		return 0, decoder.insufficient()
	}
	return count, nil
}

func (decoder *Decoder) ReadMapHeader() (int, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return 0, err
	}
	count, isMap, err := decoder.countAfterTag(tag, tagFixmap, tagFixmapLast, tagMap16, tagMap32)
	if !isMap {
		decoder.position--
		return 0, decoder.unexpected(tag, "a map")
	}
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

func (decoder *Decoder) ReadExtension() (Extension, error) {
	tag, err := decoder.readTag()
	if err != nil {
		return Extension{}, err
	}
	size, isExtension, err := decoder.extensionSizeAfterTag(tag)
	if !isExtension {
		decoder.position--
		return Extension{}, decoder.unexpected(tag, "an extension")
	}
	if err != nil {
		return Extension{}, err
	}
	extensionType, data, err := decoder.readExtensionBody(size)
	if err != nil {
		return Extension{}, err
	}
	return Extension{Type: extensionType, Data: decoder.ownedBytes(data)}, nil
}
