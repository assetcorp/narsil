package paged

import (
	"errors"
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

const RecordPageBytes = 16_384

func readFileRange(source io.ReaderAt, offset int64, target []byte, key string) error {
	read, err := source.ReadAt(target, offset)
	if read == len(target) {
		return nil
	}
	if err == nil || errors.Is(err, io.EOF) {
		err = io.ErrUnexpectedEOF
	}
	return narsilerr.Wrap(narsilerr.CodePersistenceLoadFailed,
		`The file "`+key+`" cannot be read at byte `+strconv.FormatInt(offset, 10), err,
		map[string]any{"key": key, "offset": offset, "length": len(target)})
}

func requirePage(section Section, page int64, data []byte, key string) error {
	if codec.CRC32(data) == pageChecksum(section, page) {
		return nil
	}
	return narsilerr.New(narsilerr.CodePersistenceCrcMismatch,
		`Page `+strconv.FormatInt(page, 10)+` of section "`+section.Name+`" of "`+key+`" does not match its checksum`,
		map[string]any{"key": key, "section": section.Name, "page": page})
}

func CheckSectionPages(source io.ReaderAt, section Section, key string) error {
	buffer := make([]byte, min(section.PageBytes, max(section.Length, 1)))
	for page := int64(0); page*section.PageBytes < section.Length; page++ {
		from := page * section.PageBytes
		data := buffer[:min(section.PageBytes, section.Length-from)]
		if err := readPageOf(source, section, page, data, key); err != nil {
			return err
		}
	}
	return nil
}

func ReadSectionChecked(source io.ReaderAt, section Section, key string) ([]byte, error) {
	data := make([]byte, section.Length)
	if _, native := source.(PageSource); !native {
		if err := readFileRange(source, envelope.HeaderBytes+section.Offset, data, key); err != nil {
			return nil, err
		}
		for page := int64(0); page*section.PageBytes < section.Length; page++ {
			from := page * section.PageBytes
			if err := requirePage(section, page, data[from:min(from+section.PageBytes, section.Length)], key); err != nil {
				return nil, err
			}
		}
		return data, nil
	}
	for page := int64(0); page*section.PageBytes < section.Length; page++ {
		from := page * section.PageBytes
		if err := readPageOf(source, section, page, data[from:min(from+section.PageBytes, section.Length)], key); err != nil {
			return nil, err
		}
	}
	return data, nil
}
