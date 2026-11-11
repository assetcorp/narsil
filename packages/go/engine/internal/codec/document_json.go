package codec

import (
	"bytes"
	"encoding/json"
	"errors"
)

var errDocumentJSONObject = errors.New("a document is decoded from a JSON object")

func appendJSONValue(destination []byte, value any) ([]byte, error) {
	switch typed := value.(type) {
	case *Document:
		return appendJSONDocument(destination, typed)
	case []any:
		destination = append(destination, '[')
		var err error
		for at, element := range typed {
			if at > 0 {
				destination = append(destination, ',')
			}
			if destination, err = appendJSONValue(destination, element); err != nil {
				return destination, err
			}
		}
		return append(destination, ']'), nil
	}
	encoded, err := json.Marshal(value)
	return append(destination, encoded...), err
}

func appendJSONDocument(destination []byte, document *Document) ([]byte, error) {
	if document == nil {
		return append(destination, "null"...), nil
	}
	destination = append(destination, '{')
	first := true
	for key, value := range HeldEntries(document) {
		if !first {
			destination = append(destination, ',')
		}
		first = false
		name, err := json.Marshal(key)
		if err != nil {
			return destination, err
		}
		destination = append(append(destination, name...), ':')
		if destination, err = appendJSONValue(destination, value); err != nil {
			return destination, err
		}
	}
	return append(destination, '}'), nil
}

// MarshalJSON writes d as a JSON object whose keys keep the order of d at
// every depth. Each value is written as encoding/json writes it, so a byte
// slice becomes base64 text and a time.Time becomes an RFC 3339 string.
func (d Document) MarshalJSON() ([]byte, error) {
	return appendJSONDocument(nil, &d)
}

func readJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, opens := token.(json.Delim)
	if !opens {
		return token, nil
	}
	if delimiter == '{' {
		nested := NewDocument()
		return nested, readJSONObject(decoder, nested.writable())
	}
	list := []any{}
	for decoder.More() {
		element, err := readJSONValue(decoder)
		if err != nil {
			return nil, err
		}
		list = append(list, element)
	}
	_, err = decoder.Token()
	return list, err
}

func readJSONObject(decoder *json.Decoder, state *documentState) error {
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, _ := token.(string)
		value, err := readJSONValue(decoder)
		if err != nil {
			return err
		}
		state.put(key, value)
	}
	_, err := decoder.Token()
	return err
}

// UnmarshalJSON replaces the contents of d with the JSON object in data and
// keeps the keys in the order of the text at every depth, with array-index
// keys first as Set places them. A number becomes a float64, a nested object
// a *Document, and a list a []any. JSON null leaves d as it is.
func (d *Document) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		return nil
	}
	if delimiter, opens := token.(json.Delim); !opens || delimiter != '{' {
		return errDocumentJSONObject
	}
	state := d.writable()
	state.markChanged()
	state.entries, state.positions = nil, nil
	return readJSONObject(decoder, state)
}
