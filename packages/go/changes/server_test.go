package changes_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	narsil "github.com/assetcorp/narsil/packages/go"
	"github.com/assetcorp/narsil/packages/go/changes"
)

const (
	serverReadyTimeout = 90 * time.Second
	serverStopTimeout  = 15 * time.Second
	adminCredential    = "admin-token"
	readerCredential   = "reader-token"
	outsiderCredential = "outsider-token"
	testIndex          = "shop"
	partitionCount     = 3
	vectorDimensions   = 3
)

var launcher = filepath.Join("testdata", "changes-server.mjs")

type serverSettings struct {
	WindowBytes      int
	ReaderLifetimeMs int
}

type nodeProcess struct {
	command *exec.Cmd
	url     string
	mutex   sync.Mutex
	output  strings.Builder
	done    chan struct{}
	stdin   io.WriteCloser
	replies chan string
}

func startServer(t *testing.T, settings serverSettings) *nodeProcess {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("the tests need Node.js on the PATH to start a Narsil server: %v", err)
	}
	launch := map[string]any{
		"directory":        t.TempDir(),
		"adminCredential":  adminCredential,
		"readerCredential": readerCredential,
	}
	if settings.WindowBytes > 0 {
		launch["windowBytes"] = settings.WindowBytes
	}
	if settings.ReaderLifetimeMs > 0 {
		launch["readerLifetimeMs"] = settings.ReaderLifetimeMs
	}
	encoded, err := json.Marshal(launch)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, launcher)
	command.Env = append(os.Environ(), "NARSIL_CHANGES_TEST_SERVER="+string(encoded), "NODE_OPTIONS=")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = command.Stdout
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	process := &nodeProcess{command: command, done: make(chan struct{}), stdin: stdin, replies: make(chan string, 1)}
	ready := make(chan string, 1)
	go process.watch(stdout, ready)
	t.Cleanup(process.stop)
	select {
	case port := <-ready:
		process.url = "http://127.0.0.1:" + strings.TrimSpace(port)
		return process
	case <-process.done:
		t.Fatalf("the Narsil server exited before it was ready:\n%s", process.log())
	case <-time.After(serverReadyTimeout):
		t.Fatalf("the Narsil server did not start:\n%s", process.log())
	}
	return nil
}

func (p *nodeProcess) watch(stdout interface{ Read([]byte) (int, error) }, ready chan<- string) {
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		p.mutex.Lock()
		p.output.WriteString(line + "\n")
		p.mutex.Unlock()
		if port, found := strings.CutPrefix(line, "READY "); found {
			select {
			case ready <- port:
			default:
			}
		}
		if strings.HasPrefix(line, "INSERTED ") || strings.HasPrefix(line, "FAILED ") {
			p.replies <- line
		}
	}
	_ = p.command.Wait()
	close(p.done)
}

func (p *nodeProcess) log() string {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	return p.output.String()
}

func (p *nodeProcess) stop() {
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.command.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(serverStopTimeout):
		_ = p.command.Process.Kill()
		<-p.done
	}
}

func newClient(t *testing.T, server *nodeProcess, apiKey string) *narsil.Client {
	t.Helper()
	client, err := narsil.New(narsil.Config{URLs: []string{server.url}, APIKey: apiKey})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func shopWithCapture(t *testing.T, ctx context.Context, admin *narsil.Client, previousDocument bool) {
	t.Helper()
	_, err := admin.CreateIndex(ctx, narsil.HTTPCreateIndexBody{Name: testIndex, Config: narsil.HTTPIndexBody{
		Schema: narsil.SchemaDefinition{
			"title":     {FieldType: narsil.Ptr(narsil.FieldTypeString)},
			"price":     {FieldType: narsil.Ptr(narsil.FieldTypeNumber)},
			"embedding": {FieldType: narsil.Ptr(narsil.FieldType(fmt.Sprintf("vector[%d]", vectorDimensions)))},
		},
		Partitions: &narsil.PartitionConfig{MaxPartitions: narsil.Ptr(float64(partitionCount))},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.UpdateChanges(ctx, testIndex, narsil.ChangesSetting{
		Enabled: true, PreviousDocument: narsil.Ptr(previousDocument),
	}); err != nil {
		t.Fatal(err)
	}
}

func product(at int) narsil.AnyDocument {
	return narsil.AnyDocument{
		"title":     fmt.Sprintf("product %d %s", at, strings.Repeat("with a long description ", 4)),
		"price":     float64(at),
		"embedding": []any{float64(at), 0.5, -0.25},
	}
}

func insert(t *testing.T, ctx context.Context, admin *narsil.Client, id string, document narsil.AnyDocument) {
	t.Helper()
	if _, err := admin.Insert(ctx, testIndex, narsil.InsertBody{Document: document, ID: narsil.Ptr(id)}); err != nil {
		t.Fatal(err)
	}
}

func follow(t *testing.T, ctx context.Context, reader *narsil.Client, options changes.Options) *changes.Subscription {
	t.Helper()
	subscription, err := changes.Follow(ctx, reader, testIndex, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = subscription.Close() })
	return subscription
}

func requireCode(t *testing.T, err error, code string) *narsil.Error {
	t.Helper()
	var failure *narsil.Error
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("expected a narsil error under %s, and got %v", code, err)
	}
	return failure
}

func (p *nodeProcess) insertThroughEngine(t *testing.T, id string, document narsil.AnyDocument) {
	t.Helper()
	line, err := json.Marshal(map[string]any{
		"index": testIndex, "id": id, "document": document, "vectorFields": []string{"embedding"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.stdin.Write(append(line, '\n')); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-p.replies:
		if reply != "INSERTED "+id {
			t.Fatalf("the engine refused %s: %s", id, reply)
		}
	case <-p.done:
		t.Fatalf("the Narsil server exited:\n%s", p.log())
	case <-time.After(serverReadyTimeout):
		t.Fatalf("the engine did not insert %s:\n%s", id, p.log())
	}
}
