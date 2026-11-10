package suggestions

import (
	"bytes"
	"regexp"
	"strconv"
	"time"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	is "github.com/assetcorp/narsil/packages/go/engine/internal/format/indexsettings"
	"github.com/assetcorp/narsil/packages/go/engine/internal/suggestions/phrase"
	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

const (
	countsFileWhat   = "query counts file"
	keyDay           = "day"
	keyFingerprint   = "keyFingerprint"
	keySavedAt       = "savedAt"
	keyIndexUUID     = "indexUuid"
	keyGroups        = "groups"
	keyPhrase        = "phrase"
	keyCount         = "count"
	keyPeople        = "people"
	requiredTopLevel = 4
	phraseKeys       = 3
	dayLayout        = "2006-01-02"
)

var dayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func IsDay(value string) bool {
	if !dayPattern.MatchString(value) {
		return false
	}
	parsed, err := time.Parse(dayLayout, value)
	return err == nil && parsed.Format(dayLayout) == value
}

type CountsHeader struct {
	Day         string
	Fingerprint []byte
	SavedAt     uint64
	IndexUUID   string
	HasUUID     bool
}

type OpenKind int

const (
	OpenedCountsFile OpenKind = iota
	DamagedFile
	OtherKeyFile
)

type OpenedCounts struct {
	CountsHeader
	payload     []byte
	groupsStart int
	groupsEnd   int
}

type PhraseVisitor func(group, phrase string, count uint64, people [][]byte)

func writeTopLevel(out *writer, header CountsHeader) {
	keys := requiredTopLevel
	if header.HasUUID {
		keys++
	}
	out.mapHeader(keys)
	out.text(keyDay)
	out.text(header.Day)
	out.text(keyFingerprint)
	out.binary(header.Fingerprint)
	out.text(keySavedAt)
	out.uint(header.SavedAt)
	if header.HasUUID {
		out.text(keyIndexUUID)
		out.text(header.IndexUUID)
	}
	out.text(keyGroups)
}

func sealCounts(payload []byte) ([]byte, error) {
	if envelope.HeaderBytes+len(payload) > MaxHistoryFileBytes {
		return nil, fail("A query counts file must stay at or below " + strconv.Itoa(MaxHistoryFileBytes) + " bytes")
	}
	return envelope.Pack(payload, envelope.PackOptions{FormatVersion: countsFileFormatVersion, What: countsFileWhat,
		Checksum: true})
}

func EncodeCounts(counts *DayCounts, fingerprint []byte, savedAt uint64) ([]byte, error) {
	out := &writer{}
	writeTopLevel(out, CountsHeader{Day: counts.Day, Fingerprint: fingerprint, SavedAt: savedAt})
	counts.writeGroups(out)
	return sealCounts(out.bytes)
}

func readPeople(in *reader) ([][]byte, error) {
	count, err := in.arrayHeader()
	if err != nil {
		return nil, err
	}
	if count > MaxPeoplePerPhraseInFile {
		return nil, fail("A phrase lists too many people")
	}
	people := make([][]byte, 0, count)
	for range count {
		id, err := in.binary()
		if err != nil {
			return nil, err
		}
		if len(id) != ScrambledIDBytes {
			return nil, fail("A scrambled ID has the wrong length")
		}
		people = append(people, id)
	}
	return people, nil
}

type walkedPhrase struct {
	text      string
	count     uint64
	people    [][]byte
	hasText   bool
	hasCount  bool
	hasPeople bool
}

func readPhrase(in *reader) (walkedPhrase, error) {
	var walked walkedPhrase
	fields, err := in.mapHeader()
	if err != nil {
		return walked, err
	}
	for range fields {
		key, err := in.text()
		if err != nil {
			return walked, err
		}
		switch {
		case key == keyPhrase && !walked.hasText:
			walked.text, err = in.text()
			walked.hasText = true
		case key == keyCount && !walked.hasCount:
			walked.count, err = in.uint()
			walked.hasCount = true
		case key == keyPeople && !walked.hasPeople:
			walked.people, err = readPeople(in)
			walked.hasPeople = true
		default:
			return walked, fail("A phrase holds an unexpected or repeated key \"" + key + "\"")
		}
		if err != nil {
			return walked, err
		}
	}
	if !walked.hasText || !walked.hasCount || !walked.hasPeople {
		return walked, fail("A phrase lacks a key")
	}
	return walked, nil
}

func walkGroups(in *reader, visitor PhraseVisitor, onGroup func(string)) error {
	groupCount, err := in.mapHeader()
	if err != nil {
		return err
	}
	validating := visitor == nil && onGroup == nil
	var seenGroups, seenPhrases map[string]bool
	if validating {
		seenGroups = map[string]bool{}
	}
	for range groupCount {
		group, err := in.text()
		if err != nil {
			return err
		}
		if onGroup != nil {
			onGroup(group)
		}
		if validating {
			if !is.IsGroup(group) || seenGroups[group] {
				return fail("A group is invalid or repeated")
			}
			seenGroups[group] = true
		}
		phraseCount, err := in.arrayHeader()
		if err != nil {
			return err
		}
		if validating {
			seenPhrases = map[string]bool{}
		}
		for range phraseCount {
			walked, err := readPhrase(in)
			if err != nil {
				return err
			}
			if validating {
				if !phrase.IsNormal(walked.text, FileLimits) || seenPhrases[walked.text] {
					return fail("A phrase is invalid or repeated")
				}
				if uint64(len(walked.people)) > walked.count || walked.count > MaxUint32 {
					return fail("A phrase lists more people than its count")
				}
				seenPhrases[walked.text] = true
			}
			if visitor != nil {
				visitor(group, walked.text, walked.count, walked.people)
			}
		}
	}
	return nil
}

func readTopLevel(payload []byte) (OpenedCounts, error) {
	in := newReader(payload)
	keys, err := in.mapHeader()
	if err != nil {
		return OpenedCounts{}, err
	}
	opened := OpenedCounts{payload: payload, groupsStart: -1}
	var hasDay, hasFingerprint, hasSavedAt bool
	seen := map[string]bool{}
	for range keys {
		key, err := in.text()
		if err != nil {
			return OpenedCounts{}, err
		}
		if seen[key] {
			return OpenedCounts{}, fail("The file holds the key \"" + key + "\" twice")
		}
		seen[key] = true
		switch key {
		case keyDay:
			opened.Day, err = in.text()
			hasDay = true
		case keyFingerprint:
			opened.Fingerprint, err = in.binary()
			hasFingerprint = true
		case keySavedAt:
			opened.SavedAt, err = in.uint()
			hasSavedAt = true
		case keyIndexUUID:
			opened.IndexUUID, err = in.text()
			opened.HasUUID = true
			if err == nil && (opened.IndexUUID == "" || text.UTF16Length(opened.IndexUUID) > MaxIndexUUIDLength) {
				err = fail("The file holds an indexUuid of the wrong length")
			}
		case keyGroups:
			opened.groupsStart = in.position()
			err = walkGroups(in, nil, nil)
			opened.groupsEnd = in.position()
		default:
			err = fail("The file holds an unexpected key \"" + key + "\"")
		}
		if err != nil {
			return OpenedCounts{}, err
		}
	}
	if !in.atEnd() {
		return OpenedCounts{}, fail("The payload holds bytes after its map")
	}
	if !hasDay || !hasFingerprint || !hasSavedAt || opened.groupsStart < 0 {
		return OpenedCounts{}, fail("The file lacks a required key")
	}
	return opened, nil
}

func OpenCounts(data []byte, expectedDay string, fingerprint []byte) (OpenedCounts, OpenKind, string) {
	if len(data) > MaxHistoryFileBytes {
		return OpenedCounts{}, DamagedFile, "The file is longer than " + strconv.Itoa(MaxHistoryFileBytes) + " bytes"
	}
	unpacked, err := envelope.OpenChecksummed(data, envelope.Kind{FormatVersion: countsFileFormatVersion,
		What: countsFileWhat})
	if err != nil {
		return OpenedCounts{}, DamagedFile, err.Error()
	}
	opened, err := readTopLevel(unpacked.Payload)
	if err != nil {
		return OpenedCounts{}, DamagedFile, err.Error()
	}
	if !IsDay(opened.Day) || (expectedDay != "" && opened.Day != expectedDay) {
		return OpenedCounts{}, DamagedFile, "The file holds a day that differs from its key"
	}
	if len(opened.Fingerprint) != KeyFingerprintBytes {
		return OpenedCounts{}, DamagedFile, "The key fingerprint has the wrong length"
	}
	if !bytes.Equal(opened.Fingerprint, fingerprint) {
		return OpenedCounts{}, OtherKeyFile, ""
	}
	return opened, OpenedCountsFile, ""
}

func (opened OpenedCounts) groups() *reader {
	return newReader(opened.payload[opened.groupsStart:])
}

func (opened OpenedCounts) Visit(visitor PhraseVisitor) {
	_ = walkGroups(opened.groups(), visitor, nil)
}

func (opened OpenedCounts) GroupNames() []string {
	names := make([]string, 0)
	_ = walkGroups(opened.groups(), nil, func(group string) { names = append(names, group) })
	return names
}

func (opened OpenedCounts) WithoutIndexUUID() ([]byte, error) {
	out := &writer{}
	header := opened.CountsHeader
	header.HasUUID, header.IndexUUID = false, ""
	writeTopLevel(out, header)
	out.bytes = append(out.bytes, opened.payload[opened.groupsStart:opened.groupsEnd]...)
	return sealCounts(out.bytes)
}
