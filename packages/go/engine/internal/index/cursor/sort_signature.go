package cursor

import (
	"fmt"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

func requireSignableSort(fields []model.SortField) error {
	if len(fields) > maxSortFields {
		return narsilerr.New(
			narsilerr.CodeSearchInvalidField,
			fmt.Sprintf("A sort names at most %d fields, because the paging cursor carries one value per field", maxSortFields),
			map[string]any{"count": len(fields), "limit": maxSortFields},
		)
	}
	for _, entry := range fields {
		if length := text.UTF16Length(entry.Field); length > maxSortFieldNameLength {
			shown, _ := leadingUTF16Units(entry.Field, shownSortFieldNameUnits)
			return narsilerr.New(
				narsilerr.CodeSearchInvalidField,
				fmt.Sprintf("A sort field name holds at most %d characters, because the paging cursor carries the sort with every page", maxSortFieldNameLength),
				map[string]any{"field": shown, "length": length, "limit": maxSortFieldNameLength},
			)
		}
	}
	return nil
}

func appendSortSignatureEntry(destination []byte, entry model.SortField) []byte {
	direction := text.SortDirection(entry.Direction)
	mode := text.SortModeOf(direction, text.SortMode(entry.Mode))
	destination = append(destination, '[')
	destination = appendJSONString(destination, entry.Field)
	destination = append(destination, ',')
	if entry.Direction == "" {
		destination = append(destination, "null"...)
	} else {
		destination = appendJSONString(destination, string(entry.Direction))
	}
	if mode != text.DefaultSortMode(direction) {
		destination = append(destination, ',')
		destination = appendJSONString(destination, string(mode))
	}
	return append(destination, ']')
}

func SortSignatureOf(fields []model.SortField) (model.Optional[string], error) {
	if len(fields) == 0 {
		return model.Optional[string]{}, nil
	}
	if err := requireSignableSort(fields); err != nil {
		return model.Optional[string]{}, err
	}
	signature := make([]byte, 0, initialSortSignatureBytes)
	signature = append(signature, '[')
	for index, entry := range fields {
		if index > 0 {
			signature = append(signature, ',')
		}
		signature = appendSortSignatureEntry(signature, entry)
	}
	signature = append(signature, ']')
	return model.Some(string(signature)), nil
}
