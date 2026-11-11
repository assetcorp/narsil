package metadata

import (
	"github.com/assetcorp/narsil/packages/go/engine/internal/format/form"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
)

func changesInvalid(message string) error {
	return is.Invalid("The change capture setting in the index metadata "+message, nil)
}

func readChanges(record map[string]any, meta *Metadata) error {
	raw, present := is.Present(record, "changes")
	if !present {
		return nil
	}
	setting, ok := is.AsMap(raw)
	if !ok {
		return changesInvalid("is not a map")
	}
	enabled, isFlag := setting["enabled"].(bool)
	if !isFlag {
		return changesInvalid("holds no boolean enabled")
	}
	meta.Changes = &ChangesSetting{Enabled: enabled}
	if previous, has := setting["previous_document"]; has {
		flag, isFlag := previous.(bool)
		if !isFlag {
			return changesInvalid("holds a previous_document that is not a boolean")
		}
		meta.Changes.PreviousDocument = model.Some(flag)
	}
	for _, slot := range []struct {
		key    string
		reason string
		target *model.Optional[uint64]
	}{
		{"history_max_age_ms", "holds a history age limit that is not a positive whole number", &meta.Changes.HistoryMaxAgeMS},
		{"history_max_bytes", "holds a history byte limit that is not a positive whole number", &meta.Changes.HistoryMaxBytes},
	} {
		limit, has := setting[slot.key]
		if !has {
			continue
		}
		positive, valid := is.AsPositive(limit, form.MaxSafeInteger)
		if !valid {
			return changesInvalid(slot.reason)
		}
		*slot.target = model.Some(positive)
	}
	return nil
}
