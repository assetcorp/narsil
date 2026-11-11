package export

import (
	"bytes"
	"encoding/json"
)

const headerSchemaKey = "schema"

func skipJSONValue(decoder *json.Decoder) error {
	depth := 0
	for {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		if delimiter, isDelimiter := token.(json.Delim); isDelimiter {
			if delimiter == '{' || delimiter == '[' {
				depth++
			} else {
				depth--
			}
		}
		if depth == 0 {
			return nil
		}
	}
}

func keysAt(decoder *json.Decoder, path []string) ([]string, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, isDelimiter := token.(json.Delim); !isDelimiter || delimiter != '{' {
		if isDelimiter && delimiter == '[' {
			return nil, skipRest(decoder)
		}
		return nil, nil
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, _ := token.(string)
		switch {
		case len(path) == 0:
			keys = append(keys, key)
			err = skipJSONValue(decoder)
		case key == path[0]:
			keys, err = keysAt(decoder, path[1:])
		default:
			err = skipJSONValue(decoder)
		}
		if err != nil {
			return nil, err
		}
	}
	_, err = decoder.Token()
	return keys, err
}

func skipRest(decoder *json.Decoder) error {
	for decoder.More() {
		if err := skipJSONValue(decoder); err != nil {
			return err
		}
	}
	_, err := decoder.Token()
	return err
}

func headerSchemaOrder(text []byte) []string {
	order, err := keysAt(json.NewDecoder(bytes.NewReader(text)), []string{headerIndexKey, headerSchemaKey})
	if err != nil {
		return nil
	}
	return order
}
