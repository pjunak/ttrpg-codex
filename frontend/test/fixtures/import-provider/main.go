// This test-only provider exercises the installed service/data lifecycle.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func main() {
	err := workerrpc.RunNativeWorker(context.Background(), workerrpc.NativeWorkerConfig{
		Reader: os.Stdin, Writer: os.Stdout,
		Methods: map[string]string{"service/codex.import-adapter/describe": "2.0.0", "service/codex.import-adapter/preview": "2.0.0", "service/codex.import-adapter/commit": "2.0.0"},
		HandlerFactory: workerrpc.NativeWorkerHandlerFactoryFunc(func(worker workerrpc.NativeWorkerContext) (workerrpc.RequestHandler, error) {
			data, err := workerrpc.NewAddonDataClient(worker.Peer)
			if err != nil {
				return nil, err
			}
			var mu sync.Mutex
			sequence := 0
			plans := map[string]workerrpc.AddonDataMutation{}
			return workerrpc.RequestHandlerFunc(func(ctx context.Context, request workerrpc.Request) (any, error) {
				if request.Meta == nil || request.Meta.Actor == nil || request.Meta.Actor.Role != "dm" {
					return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized, "DM required", false, nil)
				}
				mu.Lock()
				defer mu.Unlock()
				switch strings.TrimPrefix(request.Method, "service/codex.import-adapter/") {
				case "describe":
					if worker.Initialization.Addon.ID == "broken-importer" {
						return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnavailable, "Fixture unavailable", true, nil)
					}
					return map[string]any{"contractVersion": "import-adapter-description.v1", "id": "fixture-notes", "label": "External notes", "description": "Notes owned by an independent provider.", "formats": []string{"fixture-notes"}}, nil
				case "preview":
					var input struct {
						Format   string `json:"format"`
						Document struct {
							ID   string `json:"id"`
							Text string `json:"text"`
						} `json:"document"`
					}
					if json.Unmarshal(request.Params, &input) != nil || input.Format != "fixture-notes" || input.Document.ID == "" {
						return nil, fmt.Errorf("invalid fixture import")
					}
					ref := workerrpc.AddonDataReference{Kind: "collection", DataID: "notes"}
					rows, err := data.Query(ctx, request.Meta, workerrpc.AddonDataQuery{Reference: ref, Limit: 200})
					if err != nil {
						return nil, err
					}
					var revision int64
					for _, row := range rows.Documents {
						if row.Key == input.Document.ID {
							revision = row.Revision
						}
					}
					sequence++
					token := fmt.Sprintf("fixture-plan-%024d", sequence)
					plans[token] = workerrpc.AddonDataMutation{Operation: "put", Reference: ref, Key: input.Document.ID, ExpectedRevision: revision, Value: map[string]any{"text": input.Document.Text}}
					creates, updates, operation := 1, 0, "create"
					if revision > 0 {
						creates, updates, operation = 0, 1, "update"
					}
					return map[string]any{"contractVersion": "import-preview-result.v1", "token": token, "format": input.Format, "mode": "merge",
						"summary": map[string]int{"creates": creates, "updates": updates, "skips": 0, "deletes": 0}, "warnings": []string{"External provider warning"},
						"changes": []any{map[string]string{"collection": "notes", "id": input.Document.ID, "label": input.Document.Text, "operation": operation}}}, nil
				case "commit":
					var input struct {
						Token string `json:"token"`
					}
					_ = json.Unmarshal(request.Params, &input)
					mutation, ok := plans[input.Token]
					delete(plans, input.Token)
					if !ok || request.Meta.IdempotencyKey != input.Token {
						return nil, fmt.Errorf("unknown fixture plan")
					}
					if _, err := data.Transact(ctx, request.Meta, []workerrpc.AddonDataMutation{mutation}); err != nil {
						return nil, err
					}
					return map[string]any{"contractVersion": "import-commit-result.v1", "committed": true, "writes": 1, "deletes": 0}, nil
				}
				return nil, fmt.Errorf("unknown fixture method")
			}), nil
		}),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
