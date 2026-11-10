package archive

import (
	"errors"
	"io"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/format/envelope"
	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type writerStage uint8

const (
	stageConfig writerStage = iota
	stageManifest
	stageFiles
	stageHistory
	stageClosed
)

type Writer struct {
	destination io.Writer
	stage       writerStage
	history     int
	failure     error
}

func NewWriter(destination io.Writer) *Writer {
	return &Writer{destination: destination}
}

func (writer *Writer) fail(err error) error {
	if writer.failure == nil {
		writer.failure = err
	}
	return writer.failure
}

func (writer *Writer) write(chunk []byte) error {
	if len(chunk) == 0 {
		return nil
	}
	if _, err := writer.destination.Write(chunk); err != nil {
		return writer.fail(narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The snapshot archive cannot be written: the destination fails to take bytes", err, nil))
	}
	return nil
}

func (writer *Writer) enter(stage writerStage, entry string) error {
	if writer.failure != nil {
		return writer.failure
	}
	if writer.stage > stage {
		return writer.fail(saveFailed("the entry \""+entry+"\" comes after an entry that the archive orders after it",
			map[string]any{"entry": entry}))
	}
	if stage > stageManifest && writer.stage < stageFiles {
		return writer.fail(saveFailed("the entry \""+entry+"\" comes before the config and manifest entries",
			map[string]any{"entry": entry}))
	}
	if stage == stageManifest && writer.stage != stageManifest {
		return writer.fail(saveFailed("the manifest entry must follow the config entry", nil))
	}
	return nil
}

func (writer *Writer) writeHeaders(name string, size int64) error {
	headers, err := EntryHeaders(name, size)
	if err != nil {
		return writer.fail(err)
	}
	for _, header := range headers {
		if err := writer.write(header); err != nil {
			return err
		}
	}
	return nil
}

func (writer *Writer) writeBytes(name string, data []byte) error {
	if err := writer.writeHeaders(name, int64(len(data))); err != nil {
		return err
	}
	if err := writer.write(data); err != nil {
		return err
	}
	return writer.write(make([]byte, Padding(int64(len(data)))))
}

func (writer *Writer) WriteConfig(data []byte) error {
	if err := writer.enter(stageConfig, ConfigEntry); err != nil {
		return err
	}
	if err := envelope.RequireWithinFileLimit(int64(len(data)), "archive config entry"); err != nil {
		return writer.fail(err)
	}
	writer.stage = stageManifest
	return writer.writeBytes(ConfigEntry, data)
}

func (writer *Writer) WriteManifest(data []byte) error {
	if err := writer.enter(stageManifest, ManifestEntry); err != nil {
		return err
	}
	if err := envelope.RequireWithinFileLimit(int64(len(data)), "archive manifest entry"); err != nil {
		return writer.fail(err)
	}
	writer.stage = stageFiles
	return writer.writeBytes(ManifestEntry, data)
}

func (writer *Writer) WriteFile(name string, size int64, body io.Reader) error {
	if err := writer.enter(stageFiles, name); err != nil {
		return err
	}
	if err := envelope.RequireWithinFileLimit(size, "archive file \""+name+"\""); err != nil {
		return writer.fail(err)
	}
	if err := writer.writeHeaders(name, size); err != nil {
		return err
	}
	copied, err := io.CopyN(writer.destination, body, size)
	if copied < size {
		if err == nil || errors.Is(err, io.EOF) {
			return writer.fail(saveFailed("the file \""+name+"\" ends after "+strconv.FormatInt(copied, 10)+
				" of the "+strconv.FormatInt(size, 10)+" bytes that its manifest lists", map[string]any{"entry": name}))
		}
		return writer.fail(narsilerr.Wrap(narsilerr.CodePersistenceSaveFailed,
			"The snapshot archive cannot be written: the file \""+name+"\" fails to copy", err, map[string]any{"entry": name}))
	}
	return writer.write(make([]byte, Padding(size)))
}

func (writer *Writer) WriteHistory(data []byte) error {
	name := HistoryEntryPrefix + strconv.Itoa(writer.history)
	if err := writer.enter(stageHistory, name); err != nil {
		return err
	}
	if len(data) > MaxHistoryFileBytes {
		return writer.fail(saveFailed("the entry \""+name+"\" passes the history file limit", map[string]any{"entry": name}))
	}
	writer.stage = stageHistory
	writer.history++
	return writer.writeBytes(name, data)
}

func (writer *Writer) Close() error {
	if writer.failure != nil {
		return writer.failure
	}
	if writer.stage < stageFiles {
		return writer.fail(saveFailed("the archive closes before its config and manifest entries", nil))
	}
	if writer.stage == stageClosed {
		return nil
	}
	writer.stage = stageClosed
	return writer.write(EndBlocks())
}
