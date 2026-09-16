package httpapi

import (
	"net/http"
	"strconv"
	"strings"
)

// Gzip is opt-in; explicit identity preferences and exclusions win over a
// wildcard. Invalid or conflicting weights fail closed for that coding.
func negotiateGzip(r *http.Request, available bool) (useGzip, acceptable bool) {
	weights := make(map[string]int)
	for _, field := range r.Header.Values("Accept-Encoding") {
		for _, entry := range strings.Split(field, ",") {
			parts := strings.Split(entry, ";")
			coding := strings.ToLower(strings.TrimSpace(parts[0]))
			if coding != "gzip" && coding != "identity" && coding != "*" {
				continue
			}
			weight := 1000
			if len(parts) > 1 {
				name, value, ok := strings.Cut(strings.TrimSpace(parts[1]), "=")
				if !ok || !strings.EqualFold(strings.TrimSpace(name), "q") || len(parts) != 2 {
					weight = 0
				} else {
					weight = encodingWeight(strings.TrimSpace(value))
				}
			}
			if previous, exists := weights[coding]; !exists || weight < previous {
				weights[coding] = weight
			}
		}
	}
	gzipWeight, gzipExplicit := weights["gzip"]
	if !gzipExplicit {
		gzipWeight = weights["*"]
	}
	identityWeight, identityExplicit := weights["identity"]
	if !identityExplicit {
		identityWeight = 1000
		if wildcard, exists := weights["*"]; exists && wildcard == 0 {
			identityWeight = 0
		}
	}
	if available && gzipWeight > 0 && (!identityExplicit || gzipWeight >= identityWeight) {
		return true, true
	}
	return false, identityWeight > 0
}

func encodingWeight(value string) int {
	if value == "0" {
		return 0
	}
	if value == "1" {
		return 1000
	}
	if len(value) < 2 || len(value) > 5 || value[1] != '.' || (value[0] != '0' && value[0] != '1') {
		return 0
	}
	for _, digit := range value[2:] {
		if digit < '0' || digit > '9' || (value[0] == '1' && digit != '0') {
			return 0
		}
	}
	if value[0] == '1' {
		return 1000
	}
	weight, _ := strconv.Atoi(value[2:] + strings.Repeat("0", 5-len(value)))
	return weight
}
