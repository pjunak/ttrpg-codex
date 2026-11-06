package workerrpc

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"unicode"
	"unicode/utf8"
)

// LocalizedText is user-facing English text with an optional key into an
// add-on's message catalog. Workers stay English: a browser shows Text, or
// the catalog's translation of Key when the reader's language has one.
// Args fill the catalog message's {name} placeholders; Text is already filled.
type LocalizedText struct {
	Text string         `json:"text"`
	Key  string         `json:"key,omitempty"`
	Args map[string]any `json:"args,omitempty"`
	// Addon names the add-on whose catalog holds Key; empty means the add-on
	// that receives the text resolves it against the provider that sent it.
	Addon string `json:"addon,omitempty"`
}

const (
	// MaxLocalizedTextArguments bounds Args.
	MaxLocalizedTextArguments = 16
	maxLocalizedTextKey       = 500
	maxLocalizedTextArgument  = 300
)

var localizedArgumentName = regexp.MustCompile(`^[A-Za-z0-9_]{1,40}$`)

// Localized returns English text with the catalog key a browser translates it by.
func Localized(key, text string, args map[string]any) LocalizedText {
	return LocalizedText{Text: text, Key: key, Args: args}
}

// Validate reports whether the text can reach browsers: non-empty text, a key
// of at most 500 characters without control characters, and at most 16
// arguments named like placeholders whose values are strings of at most 300
// characters or finite numbers.
func (text LocalizedText) Validate() error {
	if text.Text == "" {
		return errors.New("localized text is empty")
	}
	if utf8.RuneCountInString(text.Key) > maxLocalizedTextKey {
		return fmt.Errorf("localized text key exceeds %d characters", maxLocalizedTextKey)
	}
	for _, character := range text.Key {
		if unicode.IsControl(character) {
			return errors.New("localized text key contains a control character")
		}
	}
	if len(text.Args) > MaxLocalizedTextArguments {
		return fmt.Errorf("localized text has more than %d arguments", MaxLocalizedTextArguments)
	}
	for name, value := range text.Args {
		if !localizedArgumentName.MatchString(name) {
			return fmt.Errorf("localized text argument %q is not a placeholder name", name)
		}
		if err := validLocalizedArgument(value); err != nil {
			return fmt.Errorf("localized text argument %q: %w", name, err)
		}
	}
	return nil
}

func validLocalizedArgument(value any) error {
	switch typed := value.(type) {
	case string:
		if utf8.RuneCountInString(typed) > maxLocalizedTextArgument {
			return fmt.Errorf("text exceeds %d characters", maxLocalizedTextArgument)
		}
		return nil
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return nil
	case float32:
		if math.IsInf(float64(typed), 0) || math.IsNaN(float64(typed)) {
			return errors.New("number is not finite")
		}
		return nil
	case float64:
		if math.IsInf(typed, 0) || math.IsNaN(typed) {
			return errors.New("number is not finite")
		}
		return nil
	default:
		return errors.New("value must be a string or a number")
	}
}

// IssueDetails returns error details carrying a user-facing issue and its
// catalog key. Pass them to NewRPCError with KindInvalidRequest or
// KindValidationFailed; the host forwards the issue, its key and arguments to
// the calling browser, which translates them through this add-on's catalog.
func IssueDetails(issue LocalizedText) map[string]any {
	details := map[string]any{"issue": issue.Text}
	if issue.Key != "" {
		details["issueKey"] = issue.Key
	}
	if len(issue.Args) > 0 {
		details["issueArgs"] = issue.Args
	}
	return details
}
