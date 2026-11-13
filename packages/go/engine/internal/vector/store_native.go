package vector

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
)

func (s *storeMemory) nativeLayout(head *storeHead, tables *storeTables) core.StoreLayout {
	layout := core.StoreLayout{
		Header:             head.header.pointer(),
		Dimension:          uint32(s.dimension),
		Bits:               s.bits,
		RecordsPerBlock:    uint32(s.codeLayout.capacity),
		CodePresent:        head.codePresent.pointer(),
		Centroid:           head.centroid.pointer(),
		VectorsPerBlock:    uint32(s.vectorLayout.capacity),
		VectorStrideFloats: uint32(s.vectorLayout.slotStride / 4),
		Magnitudes:         s.magnitudes.pointer(),
		Present:            s.present.pointer(),
		VectorFile:         tables.locations.files.pointer(),
		VectorOffset:       tables.locations.offsets.pointer(),
		BornAt:             s.born.pointer(),
		RetiredAt:          s.retired.pointer(),
		Pins:               s.slotTable.pins.Pointer(),
		PinSlots:           s.slotTable.committedSlots(),
	}
	for _, block := range tables.codeBlocks {
		layout.CodeBlocks = append(layout.CodeBlocks, block.slots(s.codeLayout))
	}
	for _, block := range tables.vectorBlocks {
		if block == nil {
			layout.VectorBlocks = append(layout.VectorBlocks, nil)
			continue
		}
		layout.VectorBlocks = append(layout.VectorBlocks, block.slots(s.vectorLayout))
	}
	for _, file := range tables.files {
		if file == nil || file.mapped == nil {
			layout.Files = append(layout.Files, nil)
			continue
		}
		layout.Files = append(layout.Files, file.mapped)
	}
	return layout
}
