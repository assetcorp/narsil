package vector

import (
	"encoding/binary"
	"strconv"
	"sync/atomic"

	"github.com/assetcorp/narsil/packages/go/engine/internal/codec"
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type coldMapping struct {
	users    atomic.Int64
	retired  atomic.Bool
	released atomic.Bool
	files    []*core.VectorFile
}

func (m *coldMapping) acquire() bool {
	m.users.Add(1)
	if m.retired.Load() {
		m.done()
		return false
	}
	return true
}

func (m *coldMapping) done() {
	if m.users.Add(-1) == 0 && m.retired.Load() {
		m.release()
	}
}

func (m *coldMapping) retire() {
	m.retired.Store(true)
	if m.users.Load() == 0 {
		m.release()
	}
}

func (m *coldMapping) release() {
	if !m.released.CompareAndSwap(false, true) {
		return
	}
	for _, file := range m.files {
		file.Unmap()
	}
}

func requireMappedVectorPages(file ColdGraphFile, content []byte) error {
	section := file.VectorPages
	pageBytes := uint64(section.PageBytes)
	end := section.Offset + section.Length
	if pageBytes == 0 || end < section.Offset || end > uint64(len(content)) ||
		uint64(len(section.Checksums)) != coldPageChecksumBytes*((section.Length+pageBytes-1)/pageBytes) {
		return coldReadFailed(`The vectors of "`+file.Key+`" end outside the mapped file`, file.Key)
	}
	for page := uint64(0); page*pageBytes < section.Length; page++ {
		from := section.Offset + page*pageBytes
		data := content[from:min(from+pageBytes, end)]
		listed := binary.LittleEndian.Uint32(section.Checksums[page*coldPageChecksumBytes:])
		if codec.CRC32(data) != listed {
			return narsilerr.New(narsilerr.CodePersistenceCrcMismatch,
				`Page `+strconv.FormatUint(page, 10)+` of section "vectors" of "`+file.Key+`" does not match its checksum`,
				map[string]any{"key": file.Key, "section": "vectors", "page": float64(page)})
		}
	}
	return nil
}

func (c *coldGraphField) mapFiles() (*coldMapping, error) {
	mapping := &coldMapping{files: make([]*core.VectorFile, 0, len(c.input.Files))}
	for _, file := range c.input.Files {
		mapped, err := core.MapVectorFile(file.Path)
		if err != nil {
			mapping.release()
			return nil, coreFailure("mapVectorFile", err)
		}
		mapping.files = append(mapping.files, mapped)
		if err := requireMappedVectorPages(file, mapped.Bytes()); err != nil {
			mapping.release()
			return nil, err
		}
	}
	return mapping, nil
}

func (c *coldGraphField) acquireMapping() (*coldMapping, error) {
	for {
		if c.closed.Load() {
			return nil, coldReadFailed("The vector files closed during the search", "")
		}
		if current := c.mapping.Load(); current != nil {
			if current.acquire() {
				return current, nil
			}
			continue
		}
		built, err := c.mapFiles()
		if err != nil {
			return nil, err
		}
		if !c.mapping.CompareAndSwap(nil, built) {
			built.release()
			continue
		}
		if c.closed.Load() {
			c.dropMapping()
		}
	}
}

func (c *coldGraphField) dropMapping() {
	if previous := c.mapping.Swap(nil); previous != nil {
		previous.retire()
	}
}
