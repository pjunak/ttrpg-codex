package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/application/campaignimport"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const coreImportProvider = "codex-core"

var coreImportGeneration = func() string {
	hash := sha256.Sum256([]byte("campaign-import-adapter/3.0.0"))
	return hex.EncodeToString(hash[:])
}()

type importConsumerManager interface {
	BrowserServices
	AuthorizeCampaignImportConsumer(context.Context, string, string) error
}
type campaignImportServices struct {
	manager importConsumerManager
	imports *campaignimport.Service
}

// WithCampaignImports lends the host adapter through the existing typed service
// transport. A package can neither register this provider ID nor gain core writes.
func WithCampaignImports(manager importConsumerManager, imports *campaignimport.Service) BrowserServices {
	return &campaignImportServices{manager: manager, imports: imports}
}
func (services *campaignImportServices) ConnectBrowserService(ctx context.Context, addonID, generation string, request packagemanager.BrowserServiceRequest) (packagemanager.BrowserServiceConnection, error) {
	connection, err := services.manager.ConnectBrowserService(ctx, addonID, generation, request)
	if err != nil {
		return connection, err
	}
	actor, _ := ctx.Value(browserServiceAuthorityKey{}).(workerrpc.Actor)
	if actor.Role == "dm" && request.Contract == "codex.import-adapter" && services.imports != nil && services.manager.AuthorizeCampaignImportConsumer(ctx, addonID, generation) == nil {
		connection.Providers = append(connection.Providers, packagemanager.BrowserServiceProvider{AddonID: coreImportProvider, ContractVersion: "3.0.0", Generation: coreImportGeneration})
	}
	return connection, nil
}
func (services *campaignImportServices) CallBrowserService(ctx context.Context, addonID, generation string, target packagemanager.BrowserServiceTarget, call servicebroker.MethodCall) (json.RawMessage, error) {
	if target.ProviderAddonID != coreImportProvider {
		return services.manager.CallBrowserService(ctx, addonID, generation, target, call)
	}
	if call.Context.Actor.Role != "dm" || call.Context.Actor.ID == "" {
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized, "Campaign imports require a DM session.", false, nil)
	}
	if target.Contract != "codex.import-adapter" || target.ContractVersion != "3.0.0" || target.Generation != coreImportGeneration || target.BindingRevision != 0 || services.imports == nil {
		return nil, servicebroker.ErrStaleBinding
	}
	if err := services.manager.AuthorizeCampaignImportConsumer(ctx, addonID, generation); err != nil {
		return nil, err
	}
	deadline := min(time.Until(call.Context.Deadline), 15*time.Second)
	if deadline <= 0 {
		return nil, servicebroker.ErrCallDeadline
	}
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	var result any
	var err error
	owner := campaignimport.Owner{ActorID: call.Context.Actor.ID, AddonID: addonID, Generation: generation}
	switch call.Method {
	case "describe":
		var empty struct{}
		if !decodeImportCall(call.Params, &empty) {
			return nil, servicebroker.ErrInvalidCall
		}
		result = map[string]any{"contractVersion": "import-adapter-description.v1", "id": "campaign-bundle", "label": "Campaign bundle", "description": "Reviewed characters, locations and relationships, with optional scoped add-on contributions.", "formats": []string{campaignimport.Format}, "features": []string{"receipt-status", "cancel", "record-views"}}
	case "preview":
		var input struct {
			ContractVersion string          `json:"contractVersion"`
			Format          string          `json:"format"`
			Document        json.RawMessage `json:"document"`
		}
		if !decodeImportCall(call.Params, &input) || input.ContractVersion != "import-preview.v1" || input.Format != campaignimport.Format {
			return nil, servicebroker.ErrInvalidCall
		}
		result, err = services.imports.Preview(ctx, owner, input.Document)
	case "commit", "cancel", "status":
		var input struct {
			ContractVersion string `json:"contractVersion"`
			Token           string `json:"token"`
		}
		if !decodeImportCall(call.Params, &input) || input.ContractVersion != "import-"+call.Method+".v1" || len(input.Token) != 48 {
			return nil, servicebroker.ErrInvalidCall
		}
		if call.Method == "commit" {
			if call.Context.IdempotencyKey != input.Token {
				return nil, servicebroker.ErrInvalidCall
			}
			result, err = services.imports.Commit(ctx, owner, input.Token)
		} else if call.Method == "cancel" {
			err = services.imports.Cancel(owner, input.Token)
			result = map[string]any{"cancelled": true}
		} else {
			result, err = services.imports.Status(ctx, input.Token)
		}
	default:
		return nil, servicebroker.ErrMethodNotFound
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(result)
}
func decodeImportCall(params any, value any) bool {
	body, err := json.Marshal(params)
	if err != nil {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return false
	}
	var extra any
	return decoder.Decode(&extra) == io.EOF
}
