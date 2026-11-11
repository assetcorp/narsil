package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	defaultCorePath   = "../../native"
	defaultTargetPath = "internal/core"
	copyDirectory     = "native"
	wrapperPrefix     = "zcore_"
	exitCopyFailure   = 2
	exitStaleCheckout = 1
)

const wrapperTemplate = "#if defined(__clang__)\n#pragma STDC FP_CONTRACT OFF\n#endif\n#include \"%s/%s\"\n"

var copiedParts = []string{"include", "src"}
var copiedExtensions = []string{".c", ".h"}

type plannedFile struct {
	path     string
	contents []byte
}

func main() {
	write := flag.Bool("write", false, "write the copy instead of checking it")
	corePath := flag.String("core", defaultCorePath, "the packages/native directory")
	targetPath := flag.String("target", defaultTargetPath, "the cgo package directory")
	flag.Parse()

	planned, err := planCopy(*corePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "corecopy cannot read the search core: %v\n", err)
		os.Exit(exitCopyFailure)
	}
	if *write {
		if err := writeCopy(*targetPath, planned); err != nil {
			fmt.Fprintf(os.Stderr, "corecopy cannot write the copy: %v\n", err)
			os.Exit(exitCopyFailure)
		}
		fmt.Printf("corecopy wrote %d files into %s\n", len(planned), *targetPath)
		return
	}
	differences, err := compareCopy(*targetPath, planned)
	if err != nil {
		fmt.Fprintf(os.Stderr, "corecopy cannot read the copy: %v\n", err)
		os.Exit(exitCopyFailure)
	}
	if len(differences) > 0 {
		fmt.Fprintln(os.Stderr, "The C sources in the Go module differ from packages/native. Run `go run ./internal/corecopy -write` from packages/go/engine:")
		for _, difference := range differences {
			fmt.Fprintf(os.Stderr, "  %s\n", difference)
		}
		os.Exit(exitStaleCheckout)
	}
	fmt.Printf("corecopy found the %d copied files equal to packages/native\n", len(planned))
}

func planCopy(corePath string) ([]plannedFile, error) {
	var planned []plannedFile
	wrappers := map[string]string{}
	for _, part := range copiedParts {
		root := filepath.Join(corePath, part)
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !hasCopiedExtension(entry.Name()) {
				return nil
			}
			relative, err := filepath.Rel(corePath, path)
			if err != nil {
				return err
			}
			contents, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			slashed := filepath.ToSlash(relative)
			planned = append(planned, plannedFile{path: copyDirectory + "/" + slashed, contents: contents})
			if strings.HasSuffix(slashed, ".c") {
				name := wrapperName(slashed)
				if earlier, taken := wrappers[name]; taken {
					return fmt.Errorf("%s and %s both map to the wrapper %s", earlier, slashed, name)
				}
				wrappers[name] = slashed
				wrapper := fmt.Sprintf(wrapperTemplate, copyDirectory, slashed)
				planned = append(planned, plannedFile{path: name, contents: []byte(wrapper)})
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	if len(wrappers) == 0 {
		return nil, errors.New("the core holds no C source")
	}
	sort.Slice(planned, func(left, right int) bool { return planned[left].path < planned[right].path })
	return planned, nil
}

func wrapperName(relative string) string {
	trimmed := strings.TrimSuffix(strings.TrimPrefix(relative, "src/"), ".c")
	return wrapperPrefix + strings.ReplaceAll(trimmed, "/", "_") + ".c"
}

func hasCopiedExtension(name string) bool {
	for _, extension := range copiedExtensions {
		if strings.HasSuffix(name, extension) {
			return true
		}
	}
	return false
}

func existingFiles(targetPath string) (map[string]bool, error) {
	existing := map[string]bool{}
	entries, err := os.ReadDir(targetPath)
	if errors.Is(err, fs.ErrNotExist) {
		return existing, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), wrapperPrefix) && strings.HasSuffix(entry.Name(), ".c") {
			existing[entry.Name()] = true
		}
	}
	copyRoot := filepath.Join(targetPath, copyDirectory)
	err = filepath.WalkDir(copyRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if errors.Is(walkErr, fs.ErrNotExist) {
			return fs.SkipAll
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(targetPath, path)
		if err != nil {
			return err
		}
		existing[filepath.ToSlash(relative)] = true
		return nil
	})
	return existing, err
}

func compareCopy(targetPath string, planned []plannedFile) ([]string, error) {
	existing, err := existingFiles(targetPath)
	if err != nil {
		return nil, err
	}
	var differences []string
	for _, file := range planned {
		delete(existing, file.path)
		contents, err := os.ReadFile(filepath.Join(targetPath, filepath.FromSlash(file.path)))
		if errors.Is(err, fs.ErrNotExist) {
			differences = append(differences, "missing "+file.path)
			continue
		}
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(contents, file.contents) {
			differences = append(differences, "changed "+file.path)
		}
	}
	for path := range existing {
		differences = append(differences, "extra "+path)
	}
	sort.Strings(differences)
	return differences, nil
}

func writeCopy(targetPath string, planned []plannedFile) error {
	existing, err := existingFiles(targetPath)
	if err != nil {
		return err
	}
	for _, file := range planned {
		delete(existing, file.path)
		destination := filepath.Join(targetPath, filepath.FromSlash(file.path))
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(destination, file.contents, 0o644); err != nil {
			return err
		}
	}
	for path := range existing {
		if err := os.Remove(filepath.Join(targetPath, filepath.FromSlash(path))); err != nil {
			return err
		}
	}
	return nil
}
