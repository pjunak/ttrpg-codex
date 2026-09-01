package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

const (
	mutationContractVersion = "campaign-mutation.v1"
	commitContractVersion   = "campaign-commit.v1"
	maximumMutationBody     = 16 << 20
	twinContractVersion     = "campaign-twin.v1"
	twinResultVersion       = "campaign-twin-result.v1"
)

type CampaignData interface {
	Dataset(context.Context, campaigndata.ViewRole) (campaigndata.Dataset, error)
}

type CampaignMutations interface {
	Mutate(
		context.Context,
		campaigndata.MutationAuthority,
		[]campaign.Mutation,
	) (campaign.Commit, error)
}

type CampaignMutationAuthorizer func(*http.Request) (campaigndata.MutationAuthority, error)

type CampaignTwins interface {
	MutateTwin(
		context.Context,
		campaigndata.MutationAuthority,
		campaigndata.TwinRequest,
	) (campaigndata.TwinResult, error)
}

func (s *server) registerCampaignRoutes(mux *http.ServeMux) {
	if s.campaignData != nil {
		mux.HandleFunc("GET /api/campaign", s.campaignDataset)
	}
	if s.campaignMutations != nil {
		mux.HandleFunc("POST /api/campaign/transactions", s.campaignTransaction)
	}
	if s.campaignTwins != nil {
		mux.HandleFunc("POST /api/campaign/twins", s.campaignTwinMutation)
	}
}

func SessionCampaignTwinAuthorizer(service *sessionauth.Service) CampaignMutationAuthorizer {
	return func(r *http.Request) (campaigndata.MutationAuthority, error) {
		actor, ok := sessionauth.ActorFromContext(r.Context())
		if !ok || actor.RealRole != sessionauth.RoleDM || actor.Role != sessionauth.RoleDM ||
			service == nil || !service.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
			return campaigndata.MutationAuthority{}, errAuthorizationRequired
		}
		return campaigndata.MutationAuthority{
			ActorID: "session:" + actor.SessionID, Role: campaigndata.WriteDM,
		}, nil
	}
}

func SessionCampaignMutationAuthorizer(
	service *sessionauth.Service,
) CampaignMutationAuthorizer {
	return func(r *http.Request) (campaigndata.MutationAuthority, error) {
		actor, ok := sessionauth.ActorFromContext(r.Context())
		if !ok || service == nil ||
			!service.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
			return campaigndata.MutationAuthority{}, errAuthorizationRequired
		}
		role := campaigndata.WritePlayer
		if actor.Role == sessionauth.RoleDM {
			role = campaigndata.WriteDM
		}
		return campaigndata.MutationAuthority{
			ActorID: "session:" + actor.SessionID,
			Role:    role,
		}, nil
	}
}

func (s *server) campaignTransaction(w http.ResponseWriter, r *http.Request) {
	authority, err := s.campaignWriter(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "campaign write authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "campaign mutation query parameters are not supported")
		return
	}
	var request struct {
		ContractVersion string `json:"contractVersion"`
		Mutations       []struct {
			Operation        campaign.OperationKind `json:"operation"`
			Collection       campaign.Collection    `json:"collection"`
			Key              string                 `json:"key"`
			ExpectedRevision *int64                 `json:"expectedRevision"`
			Value            json.RawMessage        `json:"value,omitempty"`
		} `json:"mutations"`
	}
	if !decodeBoundedJSON(w, r, &request, maximumMutationBody, "campaign mutation") {
		return
	}
	if request.ContractVersion != mutationContractVersion ||
		len(request.Mutations) == 0 || len(request.Mutations) > campaigndata.MaximumRequestedMutations {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "campaign mutation contract is invalid")
		return
	}
	mutations := make([]campaign.Mutation, 0, len(request.Mutations))
	for _, candidate := range request.Mutations {
		if candidate.ExpectedRevision == nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "expectedRevision is required")
			return
		}
		mutations = append(mutations, campaign.Mutation{
			Kind: candidate.Operation, Collection: candidate.Collection,
			Key: candidate.Key, ExpectedRevision: *candidate.ExpectedRevision,
			Value: append(json.RawMessage(nil), candidate.Value...),
		})
	}
	commit, err := s.campaignMutations.Mutate(r.Context(), authority, mutations)
	if err != nil {
		s.writeCampaignMutationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion":     commitContractVersion,
		"commitId":            commit.ID,
		"occurredAt":          commit.OccurredAt,
		"results":             commit.Results,
		"collectionRevisions": commit.CollectionRevisions,
	})
}

func (s *server) campaignTwinMutation(w http.ResponseWriter, r *http.Request) {
	authority, err := s.campaignTwinWriter(r)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "DM twin authorization is required")
		return
	}
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "twin mutation query parameters are not supported")
		return
	}
	var request struct {
		ContractVersion        string                  `json:"contractVersion"`
		Action                 campaigndata.TwinAction `json:"action"`
		Collection             campaign.Collection     `json:"collection"`
		SourceKey              string                  `json:"sourceKey"`
		SourceExpectedRevision *int64                  `json:"sourceExpectedRevision"`
		TargetKey              string                  `json:"targetKey,omitempty"`
		TargetExpectedRevision *int64                  `json:"targetExpectedRevision,omitempty"`
	}
	if !decodeBoundedJSON(w, r, &request, 8<<10, "campaign twin mutation") {
		return
	}
	if request.ContractVersion != twinContractVersion || request.SourceExpectedRevision == nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "campaign twin contract is invalid")
		return
	}
	targetRevision := int64(0)
	if request.TargetExpectedRevision != nil {
		targetRevision = *request.TargetExpectedRevision
	}
	result, err := s.campaignTwins.MutateTwin(r.Context(), authority, campaigndata.TwinRequest{
		Action: request.Action, Collection: request.Collection,
		SourceKey: request.SourceKey, SourceExpectedRevision: *request.SourceExpectedRevision,
		TargetKey: request.TargetKey, TargetExpectedRevision: targetRevision,
	})
	if err != nil {
		s.writeCampaignMutationError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion":     twinResultVersion,
		"twinKey":             result.TwinKey,
		"commitId":            result.Commit.ID,
		"occurredAt":          result.Commit.OccurredAt,
		"results":             result.Commit.Results,
		"collectionRevisions": result.Commit.CollectionRevisions,
	})
}

func (s *server) writeCampaignMutationError(w http.ResponseWriter, r *http.Request, err error) {
	status, kind, message := http.StatusServiceUnavailable, "CAMPAIGN_UNAVAILABLE", "campaign data is unavailable"
	switch {
	case errors.Is(err, campaigndata.ErrMutationForbidden):
		status, kind, message = http.StatusForbidden, "FORBIDDEN", "campaign mutation is not allowed"
	case errors.Is(err, campaign.ErrNotFound):
		status, kind, message = http.StatusNotFound, "NOT_FOUND", "campaign record was not found"
	case errors.Is(err, campaign.ErrConflict):
		status, kind, message = http.StatusConflict, "WRITE_CONFLICT", "campaign data changed; refresh before retrying"
	case errors.Is(err, campaigndata.ErrManagedCampaignField):
		status, kind, message = http.StatusBadRequest, "MANAGED_FIELD", "campaign mutation changes an application-managed field"
	case errors.Is(err, campaigndata.ErrTwinExists):
		status, kind, message = http.StatusConflict, "TWIN_EXISTS", "campaign record already has a twin"
	case errors.Is(err, campaigndata.ErrTwinMissing):
		status, kind, message = http.StatusConflict, "TWIN_MISSING", "campaign record does not have a valid twin"
	case errors.Is(err, campaigndata.ErrTwinVisibility):
		status, kind, message = http.StatusBadRequest, "TWIN_VISIBILITY", "twins must use opposite visibility"
	case errors.Is(err, campaign.ErrInvalidTransaction),
		errors.Is(err, campaign.ErrInvalidCollection),
		errors.Is(err, campaign.ErrInvalidRecord),
		errors.Is(err, campaigndata.ErrInvalidAuthority):
		status, kind, message = http.StatusBadRequest, "INVALID_REQUEST", "campaign mutation is invalid"
	}
	if status >= http.StatusInternalServerError {
		s.logger.Error("campaign mutation failed", "method", r.Method, "path", r.URL.Path, "error", err)
	}
	writeAPIError(w, status, kind, message)
}

func (s *server) campaignDataset(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "campaign query parameters are not supported")
		return
	}
	role := campaigndata.ViewPublic
	if actor, ok := sessionauth.ActorFromContext(r.Context()); ok && actor.Role == sessionauth.RoleDM {
		role = campaigndata.ViewDM
	}
	dataset, err := s.campaignData.Dataset(r.Context(), role)
	if err != nil {
		s.logger.Error("read campaign dataset", "role", role, "error", err)
		writeAPIError(w, http.StatusServiceUnavailable, "CAMPAIGN_UNAVAILABLE", "campaign data is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, dataset)
}
