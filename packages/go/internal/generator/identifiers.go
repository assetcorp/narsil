package main

import (
	"go/token"
	"strings"
	"unicode"
)

var initialisms = map[string]string{
	"api":    "API",
	"bm25":   "BM25",
	"cpu":    "CPU",
	"hnsw":   "HNSW",
	"http":   "HTTP",
	"id":     "ID",
	"ids":    "IDs",
	"ip":     "IP",
	"json":   "JSON",
	"ndjson": "NDJSON",
	"tcp":    "TCP",
	"tls":    "TLS",
	"ttl":    "TTL",
	"uri":    "URI",
	"url":    "URL",
	"urls":   "URLs",
	"uuid":   "UUID",
}

var reservedArguments = map[string]bool{
	"answer": true, "body": true, "ctx": true, "err": true, "exchange": true, "o": true, "options": true,
	"params": true, "query": true, "result": true,
}

func splitWords(text string) []string {
	var words []string
	var current []rune
	runes := []rune(text)
	flush := func() {
		if len(current) > 0 {
			words = append(words, string(current))
			current = nil
		}
	}
	for position, r := range runes {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			flush()
			continue
		}
		if unicode.IsUpper(r) && len(current) > 0 {
			previous := current[len(current)-1]
			nextIsLower := position+1 < len(runes) && unicode.IsLower(runes[position+1])
			if unicode.IsLower(previous) || unicode.IsDigit(previous) || (unicode.IsUpper(previous) && nextIsLower) {
				flush()
			}
		}
		current = append(current, r)
	}
	flush()
	return words
}

func capitalise(word string) string {
	if fixed, known := initialisms[strings.ToLower(word)]; known {
		return fixed
	}
	runes := []rune(strings.ToLower(word))
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

func pascalWords(text string) string {
	var built strings.Builder
	for _, word := range splitWords(text) {
		built.WriteString(capitalise(word))
	}
	return built.String()
}

func exportedName(text string) string {
	name := pascalWords(text)
	if name == "" || !token.IsIdentifier(name) || !token.IsExported(name) {
		failf("The name %q gives no exported Go identifier", text)
	}
	return name
}

func argumentName(text string) string {
	words := splitWords(text)
	if len(words) == 0 {
		failf("The parameter name %q gives no Go identifier", text)
	}
	var built strings.Builder
	built.WriteString(strings.ToLower(words[0]))
	for _, word := range words[1:] {
		built.WriteString(capitalise(word))
	}
	name := built.String()
	if token.IsKeyword(name) || reservedArguments[name] || !token.IsIdentifier(name) {
		name += "Value"
	}
	return name
}

func constantName(typeName string, value string) string {
	suffix := pascalWords(strings.ReplaceAll(value, "[]", " array "))
	if suffix == "" {
		failf("The value %q of %s gives no Go constant name", value, typeName)
	}
	name := typeName + suffix
	if !token.IsIdentifier(name) {
		failf("The value %q of %s gives no Go constant name", value, typeName)
	}
	return name
}

func fileStem(tag string) string {
	return strings.ToLower(strings.Join(splitWords(tag), "_"))
}
