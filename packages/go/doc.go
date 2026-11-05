// Package narsil calls a Narsil search server, or every node of a Narsil cluster, over HTTP.
//
// Every route of the server has a method on [Client], generated from the server's OpenAPI document,
// under the same name in Go form, such as CreateIndex for createIndex. Each method takes a
// [context.Context] first and any number of [CallOption] values last.
//
//	client, err := narsil.New(narsil.Config{URLs: []string{"http://127.0.0.1:9876"}})
//	if err != nil {
//		return err
//	}
//	results, err := client.Query(ctx, "movies", narsil.HTTPQueryParams{Term: narsil.Ptr("matrix")})
//
// Every failure comes back as an [*Error], under the code that the server sent, or under a CLIENT_ code
// when the failure happened on this side.
//
// # Failover
//
// Give [Config.URLs] the address of every node, and the client starts each call on the next address in
// turn. It moves a call to the next address only where resending cannot store anything twice. A read,
// meaning a GET or a route that the server marks as repeatable, moves on after a refused connection, a
// timeout, or an answer of 502, 503, or 504. A write moves on only when the connection was refused
// before the request left the client, or when the node answers 503 with NODE_NOT_READY, because a write
// that reached a node can have taken effect there. The client sends a body that you pass as a stream once, and
// it can send a *bytes.Reader, *bytes.Buffer, or *strings.Reader again. After an address refuses a
// connection, the client skips it for [Config.URLSkip], doubling the wait after each further refusal.
package narsil
