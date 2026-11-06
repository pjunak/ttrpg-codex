package workerrpc

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestLocalizedTextValidatesWhatBrowsersAccept(t *testing.T) {
	t.Parallel()

	valid := Localized("homebrew.unknownTarget", `Effect 1: target "speed" is not supported.`,
		map[string]any{"index": 1, "target": "speed", "ratio": 0.5})
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	tooMany := map[string]any{}
	for index := range MaxLocalizedTextArguments + 1 {
		tooMany[strings.Repeat("a", index+1)] = index
	}
	for name, text := range map[string]LocalizedText{
		"empty text":          {Key: "key"},
		"long key":            {Text: "x", Key: strings.Repeat("k", 501)},
		"control in key":      {Text: "x", Key: "bad\nkey"},
		"too many arguments":  {Text: "x", Args: tooMany},
		"argument name":       {Text: "x", Args: map[string]any{"not a name": 1}},
		"long argument":       {Text: "x", Args: map[string]any{"name": strings.Repeat("é", 301)}},
		"infinite argument":   {Text: "x", Args: map[string]any{"n": math.Inf(1)}},
		"structured argument": {Text: "x", Args: map[string]any{"list": []string{"a"}}},
	} {
		if err := text.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil", name)
		}
	}
}

func TestIssueDetailsCarryTheKeyForTheHost(t *testing.T) {
	t.Parallel()

	err := NewRPCError(JSONRPCApplication, KindInvalidRequest, "invalid homebrew item", false,
		IssueDetails(Localized("homebrew.unknownTarget", "Target speed is not supported.", map[string]any{"target": "speed"})))
	var details map[string]any
	if unmarshalErr := json.Unmarshal(err.Data.Details, &details); unmarshalErr != nil {
		t.Fatal(unmarshalErr)
	}
	if details["issue"] != "Target speed is not supported." || details["issueKey"] != "homebrew.unknownTarget" ||
		details["issueArgs"].(map[string]any)["target"] != "speed" {
		t.Fatalf("details = %v", details)
	}
	plain := IssueDetails(LocalizedText{Text: "Plain issue."})
	if len(plain) != 1 || plain["issue"] != "Plain issue." {
		t.Fatalf("plain details = %v", plain)
	}
}
