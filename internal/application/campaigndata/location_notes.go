package campaigndata

// Older activity envelopes can contain before/after text; notes are DM-owned
// regardless of whether the envelope predates the current activity contract.
func closeLocationNoteActivity(value map[string]any) {
	activity, ok := value["lastChange"].(map[string]any)
	if !ok {
		return
	}
	if change, ok := activity["change"].(map[string]any); ok {
		activity = change
	}
	fields, ok := activity["fields"].([]any)
	if !ok {
		return
	}
	filtered := make([]any, 0, len(fields))
	for _, field := range fields {
		if name, ok := field.(string); ok && name == "notes" {
			continue
		}
		if change, ok := field.(map[string]any); ok && (change["field"] == "notes" || change["key"] == "notes") {
			continue
		}
		filtered = append(filtered, field)
	}
	activity["fields"] = filtered
}
