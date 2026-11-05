package narsil_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	narsil "github.com/assetcorp/narsil/packages/go"
)

const (
	etcdEndpointVariable   = "NARSIL_ETCD_ENDPOINT"
	clusterNodeCount       = 3
	clusterPartitionCount  = 3
	clusterReplication     = 1
	clusterTotalWrites     = 1200
	clusterWriters         = 4
	clusterSearchers       = 2
	killAfterAcknowledged  = 300
	victimSlot             = 1
	recoveryTimeout        = 2 * time.Minute
	recoveryPollInterval   = 500 * time.Millisecond
	clusterListPageSize    = 500
	clusterSearchTerm      = "ridge"
	clusterRequestDeadline = time.Minute
)

type writeLedger struct {
	mutex          sync.Mutex
	acknowledged   map[int]string
	unanswered     map[int]bool
	writeFailures  map[string]int
	searchFailures map[string]int
	afterKill      int
	nextSeq        int
	killed         bool
}

func (l *writeLedger) claim() (int, bool) {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	if l.nextSeq >= clusterTotalWrites {
		return 0, false
	}
	l.nextSeq++
	return l.nextSeq - 1, true
}

func (l *writeLedger) writing() bool {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return l.nextSeq < clusterTotalWrites
}

func (l *writeLedger) settle(seq int, id string, err error) bool {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	if err != nil {
		l.unanswered[seq] = true
		l.writeFailures[narsil.ErrorCode(err)]++
		return false
	}
	l.acknowledged[seq] = id
	if !l.killed && len(l.acknowledged) >= killAfterAcknowledged {
		l.killed = true
		return true
	}
	return false
}

func (l *writeLedger) searched(err error) {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	if l.killed {
		l.afterKill++
	}
	if err != nil {
		l.searchFailures[narsil.ErrorCode(err)]++
	}
}

func startCluster(t *testing.T) []*nodeProcess {
	t.Helper()
	endpoint := os.Getenv(etcdEndpointVariable)
	if endpoint == "" {
		t.Skipf("the cluster test needs a running etcd at %s", etcdEndpointVariable)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	keyPrefix := "_narsil_go_client_" + hex.EncodeToString(suffix)
	directory := t.TempDir()
	nodes := make([]*nodeProcess, 0, clusterNodeCount)
	for slot := range clusterNodeCount {
		nodes = append(nodes, startNode(t, map[string]any{
			"mode":                 "cluster",
			"etcdEndpoints":        []string{endpoint},
			"keyPrefix":            keyPrefix,
			"heartbeatTtlSeconds":  5,
			"nodeId":               fmt.Sprintf("go-client-node-%d", slot),
			"httpPort":             freePort(t),
			"transportPort":        freePort(t),
			"directory":            filepath.Join(directory, fmt.Sprintf("node-%d", slot)),
			"backupDirectory":      filepath.Join(directory, "backups"),
			"controllerLeaseTtlMs": 5000,
			"standbyRetryMs":       1000,
			"partitionCount":       clusterPartitionCount,
			"replicationFactor":    clusterReplication,
			"waitForServingMs":     30000,
		}))
	}
	return nodes
}

func runBurst(ctx context.Context, client *narsil.Client, name string, ledger *writeLedger, victim *nodeProcess) {
	var group sync.WaitGroup
	for range clusterWriters {
		group.Go(func() {
			for seq, more := ledger.claim(); more; seq, more = ledger.claim() {
				answer, err := client.Insert(ctx, name, narsil.InsertBody{
					Document: narsil.AnyDocument{"title": fmt.Sprintf("%s trail %d", clusterSearchTerm, seq), "seq": seq},
				})
				id := ""
				if answer != nil {
					id = answer.ID
				}
				if ledger.settle(seq, id, err) {
					victim.kill()
				}
			}
		})
	}
	for range clusterSearchers {
		group.Go(func() {
			for ledger.writing() {
				_, err := client.Query(ctx, name, narsil.HTTPQueryParams{Term: narsil.Ptr(clusterSearchTerm), Limit: narsil.Ptr(1.0)})
				ledger.searched(err)
			}
		})
	}
	group.Wait()
}

func untilEveryPartitionHasAPrimary(t *testing.T, client *narsil.Client, name string) {
	t.Helper()
	deadline := time.Now().Add(recoveryTimeout)
	var last any
	for time.Now().Before(deadline) {
		health, err := client.GetClusterHealth(testContext(t))
		if err != nil {
			last = err
		} else {
			last = health
			for _, index := range health.Indexes {
				if index.IndexName == name && index.PartitionsWithoutPrimary == 0 {
					return
				}
			}
		}
		time.Sleep(recoveryPollInterval)
	}
	t.Fatalf("the cluster kept a partition without a primary: %+v", last)
}

func storedIDsBySeq(t *testing.T, client *narsil.Client, name string) map[int][]string {
	t.Helper()
	stored := map[int][]string{}
	params := narsil.ListParams{Limit: narsil.Ptr(float64(clusterListPageSize))}
	for {
		page, err := client.ListDocuments(testContext(t), name, params)
		if err != nil {
			t.Fatal(err)
		}
		for _, listed := range page.Documents {
			seq, isNumber := listed.Document["seq"].(float64)
			if !isNumber {
				t.Fatalf("the stored document %s holds no seq: %v", listed.ID, listed.Document)
			}
			stored[int(seq)] = append(stored[int(seq)], listed.ID)
		}
		if page.Cursor == nil {
			return stored
		}
		params.Cursor = page.Cursor
	}
}

func TestClientGivenEveryNodeKeepsEachAcknowledgedWriteExactlyOnceWhenANodeDies(t *testing.T) {
	nodes := startCluster(t)
	urls := make([]string, 0, len(nodes))
	for _, node := range nodes {
		urls = append(urls, node.url)
	}
	client := newClient(t, narsil.Config{URLs: urls, Timeout: clusterRequestDeadline})
	ctx := testContext(t)
	name := indexName(t)
	if _, err := client.CreateIndex(ctx, narsil.HTTPCreateIndexBody{
		Name:   name,
		Config: narsil.HTTPIndexBody{Schema: narsil.SchemaDefinition{"title": {FieldType: narsil.Ptr(narsil.FieldTypeString)}}},
	}); err != nil {
		t.Fatal(err)
	}
	ledger := &writeLedger{
		acknowledged: map[int]string{}, unanswered: map[int]bool{}, writeFailures: map[string]int{},
		searchFailures: map[string]int{},
	}
	runBurst(ctx, client, name, ledger, nodes[victimSlot])
	if !ledger.killed {
		t.Fatal("the burst finished before the test killed a node")
	}
	untilEveryPartitionHasAPrimary(t, client, name)
	stored := storedIDsBySeq(t, client, name)

	for seq, id := range ledger.acknowledged {
		if ids := stored[seq]; len(ids) != 1 || ids[0] != id {
			t.Fatalf("write %d answered %s but the cluster holds %v", seq, id, ids)
		}
	}
	total := 0
	for seq, ids := range stored {
		total += len(ids)
		_, acknowledged := ledger.acknowledged[seq]
		if !acknowledged && !ledger.unanswered[seq] {
			t.Fatalf("the cluster holds write %d, which the test never sent", seq)
		}
		if ledger.unanswered[seq] && len(ids) > 1 {
			t.Fatalf("unanswered write %d is stored %v", seq, ids)
		}
	}
	if ledger.afterKill == 0 {
		t.Fatal("no search ran after the kill")
	}
	if failures := ledger.searchFailures[narsil.CodeClientConnectionFailed]; failures != 0 {
		t.Fatalf("%d searches surfaced a refused connection in place of moving on", failures)
	}
	if len(ledger.unanswered) > clusterWriters {
		t.Fatalf("%d writes failed %v, more than the %d in flight at the kill", len(ledger.unanswered), ledger.writeFailures, clusterWriters)
	}
	found, err := client.Query(ctx, name, narsil.HTTPQueryParams{Term: narsil.Ptr(clusterSearchTerm), Limit: narsil.Ptr(1.0)})
	if err != nil {
		t.Fatal(err)
	}
	if int(found.Count) != total {
		t.Fatalf("the search counts %v documents while the cluster lists %d", found.Count, total)
	}
	t.Logf("%d acknowledged, %d unanswered %v, %d searches after the kill %v, %d stored",
		len(ledger.acknowledged), len(ledger.unanswered), ledger.writeFailures, ledger.afterKill, ledger.searchFailures, total)
}
