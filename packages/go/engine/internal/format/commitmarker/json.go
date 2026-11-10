package commitmarker

import (
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func (marker Marker) JSONValue() map[string]any {
	slots := make([]any, SlotCount)
	for index, candidate := range marker.Slots {
		slot, valid := candidate.Get()
		if !valid {
			continue
		}
		slots[index] = map[string]any{
			"writeSeq":            float64(slot.WriteSeq),
			"activeSegmentSeqNo":  float64(slot.ActiveSegmentSeqNo),
			"durableByteLength":   float64(slot.DurableByteLength),
			"highestDurableSeqNo": float64(slot.HighestDurableSeqNo),
		}
	}
	return map[string]any{"slots": slots}
}

func FromJSON(value map[string]any) (Marker, error) {
	fields := form.NewFields(value, "", form.CodeJSONForm, "commit marker JSON form")
	list := fields.List("slots")
	var marker Marker
	if fields.Err() == nil && len(list) != SlotCount {
		fields.Fail("slots", "does not hold exactly "+strconv.Itoa(SlotCount)+" slots")
	}
	if fields.Err() != nil {
		return Marker{}, fields.Err()
	}
	for index := range list {
		if list[index] == nil {
			continue
		}
		slot := fields.Element(list, "slots", index)
		marker.Slots[index] = model.Some(Slot{
			WriteSeq:            slot.Uint("writeSeq", form.MaxSafeInteger),
			ActiveSegmentSeqNo:  slot.Uint("activeSegmentSeqNo", form.MaxSafeInteger),
			DurableByteLength:   slot.Uint("durableByteLength", form.MaxSafeInteger),
			HighestDurableSeqNo: slot.Uint("highestDurableSeqNo", form.MaxSafeInteger),
		})
	}
	return marker, fields.Err()
}
