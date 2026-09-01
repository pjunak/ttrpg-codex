package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/application/campaigndata"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
)

type CampaignData interface {
	Dataset(context.Context, campaigndata.ViewRole) (campaigndata.Dataset, error)
}

func (s *server) registerCampaignRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/campaign", s.campaignDataset)
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
