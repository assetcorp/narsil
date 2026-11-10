package analysis

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/model"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type namedEntries[V any] struct {
	byName map[string]V
	order  []string
}

func (n *namedEntries[V]) set(name string, value V) {
	if _, held := n.byName[name]; !held {
		n.order = append(n.order, name)
	}
	n.byName[name] = value
}

func (n *namedEntries[V]) names() []string {
	return append([]string{}, n.order...)
}

type Registry struct {
	mu         sync.RWMutex
	tokenizers namedEntries[model.Tokenizer]
	stopWords  namedEntries[model.StopWords]
}

func NewRegistry() *Registry {
	return &Registry{
		tokenizers: namedEntries[model.Tokenizer]{byName: map[string]model.Tokenizer{}},
		stopWords:  namedEntries[model.StopWords]{byName: map[string]model.StopWords{}},
	}
}

func IsECMAScriptWhiteSpace(character rune) bool {
	switch character {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return character >= 0x2000 && character <= 0x200A
}

func IsBlank(value string) bool {
	for _, character := range value {
		if !IsECMAScriptWhiteSpace(character) {
			return false
		}
	}
	return true
}

func requireName(name, kind string) error {
	if IsBlank(name) {
		return narsilerr.New(narsilerr.CodeConfigInvalid, "A registered "+kind+" needs a non-empty name", map[string]any{"name": name})
	}
	return nil
}

func (r *Registry) RegisterTokenizer(name string, tokenizer model.Tokenizer) error {
	if err := requireName(name, "tokenizer"); err != nil {
		return err
	}
	if tokenizer == nil {
		return narsilerr.New(narsilerr.CodeConfigInvalid, `Tokenizer "`+name+`" needs a tokenize method`, map[string]any{"tokenizer": name})
	}
	r.mu.Lock()
	r.tokenizers.set(name, tokenizer)
	r.mu.Unlock()
	return nil
}

func (r *Registry) RegisterStopWords(name string, stopWords model.StopWords) error {
	if err := requireName(name, "stop word set"); err != nil {
		return err
	}
	_, isSet := stopWords.Set()
	function, isFunction := stopWords.Function()
	if !isSet && (!isFunction || function == nil) {
		return narsilerr.New(narsilerr.CodeConfigInvalid, `Stop word set "`+name+`" needs a Set of words or a function returning one`, map[string]any{"stopWords": name})
	}
	r.mu.Lock()
	r.stopWords.set(name, stopWords)
	r.mu.Unlock()
	return nil
}

func (r *Registry) HasTokenizer(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, found := r.tokenizers.byName[name]
	return found
}

func (r *Registry) HasStopWords(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, found := r.stopWords.byName[name]
	return found
}

func (r *Registry) Tokenizer(name string) (model.Tokenizer, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	tokenizer, found := r.tokenizers.byName[name]
	if !found {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid, `Tokenizer "`+name+`" is not registered on this engine`,
			map[string]any{"tokenizer": name, "available": r.tokenizers.names()})
	}
	return tokenizer, nil
}

func (r *Registry) StopWords(name string) (model.StopWords, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	stopWords, found := r.stopWords.byName[name]
	if !found {
		return model.StopWords{}, narsilerr.New(narsilerr.CodeConfigInvalid, `Stop word set "`+name+`" is not registered on this engine`,
			map[string]any{"stopWords": name, "available": r.stopWords.names()})
	}
	return stopWords, nil
}
