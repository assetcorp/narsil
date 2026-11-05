package narsil_test

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	narsil "github.com/assetcorp/narsil/packages/go"
)

const (
	serverReadyTimeout = 90 * time.Second
	serverStopTimeout  = 15 * time.Second
	securedAPIKey      = "narsil-client-test-key"
	securedImportLimit = 4096
	proxyErrorPage     = "<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>"
)

var launcher = filepath.Join("..", "ts", "scripts", "client-test-server.mjs")

type nodeProcess struct {
	command *exec.Cmd
	url     string
	mutex   sync.Mutex
	output  strings.Builder
	done    chan struct{}
}

var shared struct {
	plain   *nodeProcess
	secured *nodeProcess
}

func TestMain(m *testing.M) {
	plain, err := launch(map[string]any{})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	secured, err := launch(map[string]any{"apiKey": securedAPIKey, "maxImportBytes": securedImportLimit})
	if err != nil {
		plain.stop()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	shared.plain, shared.secured = plain, secured
	code := m.Run()
	plain.stop()
	secured.stop()
	os.Exit(code)
}

func startNode(t testing.TB, settings map[string]any) *nodeProcess {
	t.Helper()
	process, err := launch(settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(process.stop)
	return process
}

func launch(settings map[string]any) (*nodeProcess, error) {
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, fmt.Errorf("the tests need Node.js on the PATH to start a Narsil server: %w", err)
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return nil, err
	}
	command := exec.Command(node, launcher)
	command.Env = append(os.Environ(), "NARSIL_CLIENT_TEST_SERVER="+string(encoded), "NODE_OPTIONS=")
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	command.Stderr = command.Stdout
	if err := command.Start(); err != nil {
		return nil, err
	}
	process := &nodeProcess{command: command, done: make(chan struct{})}
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			process.mutex.Lock()
			process.output.WriteString(line + "\n")
			process.mutex.Unlock()
			if port, found := strings.CutPrefix(line, "READY "); found {
				select {
				case ready <- port:
				default:
				}
			}
		}
		_ = command.Wait()
		close(process.done)
	}()
	select {
	case port := <-ready:
		process.url = "http://127.0.0.1:" + strings.TrimSpace(port)
		return process, nil
	case <-process.done:
		return nil, fmt.Errorf("the Narsil server exited before it was ready:\n%s", process.log())
	case <-time.After(serverReadyTimeout):
		process.kill()
		return nil, fmt.Errorf("the Narsil server did not start:\n%s", process.log())
	}
}

func (p *nodeProcess) log() string {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	return p.output.String()
}

func (p *nodeProcess) kill() {
	_ = p.command.Process.Kill()
	select {
	case <-p.done:
	case <-time.After(serverStopTimeout):
	}
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
		p.kill()
	}
}

func freePort(t testing.TB) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func proxyToNowhere(t testing.TB) string {
	t.Helper()
	upstream, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", freePort(t)))
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, _ error) {
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		writer.WriteHeader(http.StatusBadGateway)
		_, _ = writer.Write([]byte(proxyErrorPage))
	}
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	return server.URL
}

func newClient(t testing.TB, config narsil.Config) *narsil.Client {
	t.Helper()
	client, err := narsil.New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func indexName(t testing.TB) string {
	t.Helper()
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	return "go_" + hex.EncodeToString(suffix)
}

func testContext(t testing.TB) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func requireCode(t testing.TB, err error, code string, status int) {
	t.Helper()
	var failure *narsil.Error
	if !errors.As(err, &failure) {
		t.Fatalf("expected a narsil error under %s, and got %v", code, err)
	}
	if failure.Code != code || failure.Status != status {
		t.Fatalf("expected %s with HTTP %d, and got %s with HTTP %d: %s", code, status, failure.Code, failure.Status, failure.Message)
	}
}
