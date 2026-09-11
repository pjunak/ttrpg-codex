package httpapi

import (
	"context"
	"net/http"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
)

type AddonUninstaller interface {
	PrepareUninstall(context.Context, string) (packagemanager.UninstallReview, error)
	Uninstall(context.Context, string, string) (packagemanager.UninstallResult, error)
}

var _ AddonUninstaller = (*packagemanager.Manager)(nil)

func (s *server) uninstallAddon(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	uninstaller, ok := s.addonLifecycle.(AddonUninstaller)
	if !ok {
		writeAPIError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "add-on uninstall is unavailable")
		return
	}
	var request struct {
		ReviewSHA256 string `json:"reviewSha256"`
	}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	if !validAddonGeneration(request.ReviewSHA256) {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "the current uninstall review fingerprint is required")
		return
	}
	result, err := uninstaller.Uninstall(r.Context(), addonID, request.ReviewSHA256)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) reviewAddonUninstall(w http.ResponseWriter, r *http.Request) {
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return
	}
	uninstaller, ok := s.addonLifecycle.(AddonUninstaller)
	if !ok {
		writeAPIError(w, http.StatusServiceUnavailable, "UNAVAILABLE", "add-on uninstall is unavailable")
		return
	}
	var request struct{}
	if !decodeAdminJSON(w, r, &request) {
		return
	}
	result, err := uninstaller.PrepareUninstall(r.Context(), addonID)
	if err != nil {
		s.writeLifecycleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
