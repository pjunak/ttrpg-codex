package packageinspect

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Message catalogs follow contracts/addons/v3/message-catalog.schema.json.
// frontend/src/core/message-catalog.ts applies the same rules; both run the
// fixtures in contracts/addons/v3/examples/catalogs/.
const (
	CatalogContract       = "message-catalog.v1"
	ManifestSection       = "manifest"
	MaxCatalogBytes       = 2 << 20
	MaxCatalogMessages    = 20_000
	maxCatalogIssues      = 16
	maxCatalogIssueLength = 300
)

// LocaleCatalog is one language's effective catalog: the package file with
// rule-breaking messages dropped and the manifest section the host builds or
// folds in. A catalog problem is an issue, never an inspection failure, so a
// package with a broken translation still installs and starts.
type LocaleCatalog struct {
	Locale string `json:"locale"`
	// Path is the declared package file; empty when only manifest labels supply the language.
	Path     string   `json:"path,omitempty"`
	SHA256   string   `json:"sha256"`
	Messages int      `json:"messages"`
	Sections []string `json:"sections"`
	Issues   []string `json:"issues,omitempty"`
	body     []byte
}

// Body returns the catalog's message-catalog.v1 JSON.
func (catalog LocaleCatalog) Body() []byte {
	return bytes.Clone(catalog.body)
}

var (
	placeholderPattern = regexp.MustCompile(`\{([A-Za-z0-9_]+)\}`)
	pluralFormOrder    = []string{"zero", "one", "two", "few", "many", "other"}
)

type catalogMessage struct {
	text  string
	forms map[string]string // nil for a single message
}

func (message catalogMessage) plural() bool {
	return message.forms != nil
}

func (message catalogMessage) placeholders() map[string]struct{} {
	names := map[string]struct{}{}
	texts := []string{message.text}
	if message.plural() {
		texts = texts[:0]
		for _, text := range message.forms {
			texts = append(texts, text)
		}
	}
	for _, text := range texts {
		for _, match := range placeholderPattern.FindAllStringSubmatch(text, -1) {
			names[match[1]] = struct{}{}
		}
	}
	return names
}

type catalogEntry struct {
	key     string
	message catalogMessage
}

type catalogSection struct {
	id      string
	entries []catalogEntry
}

type messageCatalog struct {
	locale   string
	sections []catalogSection
}

func (catalog *messageCatalog) messageCount() int {
	count := 0
	for _, section := range catalog.sections {
		count += len(section.entries)
	}
	return count
}

func (catalog *messageCatalog) find(key string) (string, catalogMessage, bool) {
	for _, section := range catalog.sections {
		for _, entry := range section.entries {
			if entry.key == key {
				return section.id, entry.message, true
			}
		}
	}
	return "", catalogMessage{}, false
}

// checkCatalog applies the catalog rules to one file. A file with the wrong
// shape or language is rejected whole (nil catalog); a message that breaks a
// translation rule is dropped. A nil english marks a source catalog, which
// must not write the reserved manifest section.
func (i *Inspector) checkCatalog(body []byte, locale string, english *messageCatalog) (*messageCatalog, []string, []string) {
	reject := func(issue string) (*messageCatalog, []string, []string) {
		return nil, []string{issue}, nil
	}
	if len(body) > MaxCatalogBytes {
		return reject(fmt.Sprintf("the file is larger than %d bytes", MaxCatalogBytes))
	}
	if err := rejectDuplicateMembers(body); err != nil {
		return reject("not valid JSON: " + err.Error())
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return reject("not valid JSON: " + err.Error())
	}
	if err := i.catalogSchema.Validate(instance); err != nil {
		return reject("not a message-catalog.v1 file: " + schemaReason(err))
	}
	catalog, err := orderedCatalog(body)
	if err != nil {
		return reject("not a message-catalog.v1 file: " + err.Error())
	}
	if catalog.locale != locale {
		return reject(fmt.Sprintf("the file is for %s, not %s", catalog.locale, locale))
	}
	if catalog.messageCount() > MaxCatalogMessages {
		return reject(fmt.Sprintf("more than %d messages", MaxCatalogMessages))
	}
	var issues, dropped []string
	seen := map[string]struct{}{}
	for index := range catalog.sections {
		section := &catalog.sections[index]
		kept := section.entries[:0]
		for _, entry := range section.entries {
			if issue := catalogMessageIssue(section.id, entry, seen, english); issue != "" {
				issues = append(issues, entry.key+": "+issue)
				dropped = append(dropped, entry.key)
				continue
			}
			seen[entry.key] = struct{}{}
			kept = append(kept, entry)
		}
		section.entries = kept
	}
	return catalog, issues, dropped
}

func catalogMessageIssue(sectionID string, entry catalogEntry, seen map[string]struct{}, english *messageCatalog) string {
	if _, duplicate := seen[entry.key]; duplicate {
		return "the key already appears in another section"
	}
	manifestKey := strings.HasPrefix(entry.key, ManifestSection+".")
	if sectionID == ManifestSection && english == nil {
		return "the host writes the English manifest section"
	}
	if manifestKey != (sectionID == ManifestSection) {
		if manifestKey {
			return "manifest keys belong in the manifest section"
		}
		return "the manifest section holds only manifest keys"
	}
	if english == nil {
		return ""
	}
	englishSection, englishMessage, found := english.find(entry.key)
	if !found {
		return "the key is not in the English catalog"
	}
	if englishSection != sectionID {
		return "the English key is in section " + englishSection
	}
	if !englishMessage.plural() && entry.message.plural() {
		return "plural forms cannot translate a single English message"
	}
	if !sameNames(entry.message.placeholders(), englishMessage.placeholders()) {
		return "placeholders differ from the English message"
	}
	return ""
}

func sameNames(left, right map[string]struct{}) bool {
	if len(left) != len(right) {
		return false
	}
	for name := range left {
		if _, found := right[name]; !found {
			return false
		}
	}
	return true
}

// rejectDuplicateMembers fails when any JSON object repeats a member name,
// which encoding/json and the schema validator would silently collapse.
func rejectDuplicateMembers(body []byte) error {
	type frame struct {
		object     bool
		expectName bool
		names      map[string]struct{}
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var stack []*frame
	valueRead := func() {
		if len(stack) > 0 && stack[len(stack)-1].object {
			stack[len(stack)-1].expectName = true
		}
	}
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{', '[':
				valueRead()
				stack = append(stack, &frame{object: value == '{', expectName: true, names: map[string]struct{}{}})
			default:
				stack = stack[:len(stack)-1]
			}
		case string:
			if top := len(stack) - 1; top >= 0 && stack[top].object && stack[top].expectName {
				if _, duplicate := stack[top].names[value]; duplicate {
					return fmt.Errorf("member %q appears twice in one object", value)
				}
				stack[top].names[value] = struct{}{}
				stack[top].expectName = false
				continue
			}
			valueRead()
		default:
			valueRead()
		}
	}
}

// orderedCatalog reads a schema-valid catalog keeping section and key order.
func orderedCatalog(body []byte) (*messageCatalog, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := expectDelimiter(decoder, '{'); err != nil {
		return nil, err
	}
	catalog := &messageCatalog{}
	for decoder.More() {
		name, err := stringToken(decoder)
		if err != nil {
			return nil, err
		}
		switch name {
		case "locale":
			catalog.locale, err = stringToken(decoder)
		case "sections":
			catalog.sections, err = orderedSections(decoder)
		default:
			var skipped json.RawMessage
			err = decoder.Decode(&skipped)
		}
		if err != nil {
			return nil, err
		}
	}
	return catalog, expectDelimiter(decoder, '}')
}

func orderedSections(decoder *json.Decoder) ([]catalogSection, error) {
	if err := expectDelimiter(decoder, '{'); err != nil {
		return nil, err
	}
	var sections []catalogSection
	for decoder.More() {
		id, err := stringToken(decoder)
		if err != nil {
			return nil, err
		}
		if err := expectDelimiter(decoder, '{'); err != nil {
			return nil, err
		}
		section := catalogSection{id: id}
		for decoder.More() {
			key, err := stringToken(decoder)
			if err != nil {
				return nil, err
			}
			message, err := orderedMessage(decoder)
			if err != nil {
				return nil, err
			}
			section.entries = append(section.entries, catalogEntry{key: key, message: message})
		}
		if err := expectDelimiter(decoder, '}'); err != nil {
			return nil, err
		}
		sections = append(sections, section)
	}
	return sections, expectDelimiter(decoder, '}')
}

func orderedMessage(decoder *json.Decoder) (catalogMessage, error) {
	token, err := decoder.Token()
	if err != nil {
		return catalogMessage{}, err
	}
	switch value := token.(type) {
	case string:
		return catalogMessage{text: value}, nil
	case json.Delim:
		if value != '{' {
			return catalogMessage{}, errors.New("a message must be a string or plural forms")
		}
		forms := map[string]string{}
		for decoder.More() {
			form, err := stringToken(decoder)
			if err != nil {
				return catalogMessage{}, err
			}
			if forms[form], err = stringToken(decoder); err != nil {
				return catalogMessage{}, err
			}
		}
		return catalogMessage{forms: forms}, expectDelimiter(decoder, '}')
	default:
		return catalogMessage{}, errors.New("a message must be a string or plural forms")
	}
}

func stringToken(decoder *json.Decoder) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", err
	}
	value, ok := token.(string)
	if !ok {
		return "", fmt.Errorf("expected a string, found %v", token)
	}
	return value, nil
}

func expectDelimiter(decoder *json.Decoder, delimiter json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token != delimiter {
		return fmt.Errorf("expected %v, found %v", delimiter, token)
	}
	return nil
}

// schemaReason is the first specific problem of a schema validation error.
// Its header line names the schema by a local file URL, which helps no one.
func schemaReason(err error) string {
	lines := strings.Split(err.Error(), "\n")
	for _, line := range lines[1:] {
		if reason := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- ")); reason != "" {
			return reason
		}
	}
	return strings.TrimSpace(lines[0])
}

// encode writes the effective catalog in file order, omitting empty sections.
func (catalog *messageCatalog) encode() ([]byte, error) {
	var buffer bytes.Buffer
	write := func(value any) error {
		body, err := json.Marshal(value)
		if err == nil {
			buffer.Write(body)
		}
		return err
	}
	buffer.WriteString(`{"contractVersion":"` + CatalogContract + `","locale":`)
	if err := write(catalog.locale); err != nil {
		return nil, err
	}
	buffer.WriteString(`,"sections":{`)
	firstSection := true
	for _, section := range catalog.sections {
		if len(section.entries) == 0 {
			continue
		}
		if !firstSection {
			buffer.WriteByte(',')
		}
		firstSection = false
		if err := write(section.id); err != nil {
			return nil, err
		}
		buffer.WriteString(":{")
		for index, entry := range section.entries {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := write(entry.key); err != nil {
				return nil, err
			}
			buffer.WriteByte(':')
			if !entry.message.plural() {
				if err := write(entry.message.text); err != nil {
					return nil, err
				}
				continue
			}
			buffer.WriteByte('{')
			firstForm := true
			for _, form := range pluralFormOrder {
				text, present := entry.message.forms[form]
				if !present {
					continue
				}
				if !firstForm {
					buffer.WriteByte(',')
				}
				firstForm = false
				if err := write(form); err != nil {
					return nil, err
				}
				buffer.WriteByte(':')
				if err := write(text); err != nil {
					return nil, err
				}
			}
			buffer.WriteByte('}')
		}
		buffer.WriteByte('}')
	}
	buffer.WriteString("}}")
	return buffer.Bytes(), nil
}

// manifestEntries is the English manifest section built from addon.json.
func manifestEntries(manifest Manifest) []catalogEntry {
	var entries []catalogEntry
	seen := map[string]struct{}{}
	add := func(key, text string) {
		if _, duplicate := seen[key]; duplicate || strings.TrimSpace(text) == "" {
			return
		}
		seen[key] = struct{}{}
		entries = append(entries, catalogEntry{key: key, message: catalogMessage{text: text}})
	}
	add("manifest.name", manifest.Name)
	add("manifest.description", manifest.Description)
	for _, contribution := range manifest.Contributions {
		label := contribution.Label
		if english := contributionLabel(contribution, "en"); english != "" {
			label = english
		}
		add("manifest.contribution."+contribution.ID+".label", label)
	}
	for _, permission := range manifest.Permissions {
		add("manifest.permission."+permission.ID+".reason", permission.Reason)
	}
	for _, dependency := range manifest.Dependencies {
		add("manifest.dependency."+dependency.ID+".reason", dependency.Reason)
	}
	if manifest.Rules != nil && manifest.Rules.Defines != nil {
		add("manifest.rules.name", manifest.Rules.Defines.Name)
	}
	for _, set := range manifest.Content {
		if set.Groups != nil {
			add("manifest.content."+set.ID+".groups.label", set.Groups.Label)
		}
	}
	return entries
}

// contributionLabel reads the deprecated config.labels entry for locale.
func contributionLabel(contribution Contribution, locale string) string {
	labels, _ := contribution.Config["labels"].(map[string]any)
	label, _ := labels[locale].(string)
	return label
}

func contributionLabelLocales(manifest Manifest) []string {
	locales := map[string]struct{}{}
	for _, contribution := range manifest.Contributions {
		labels, _ := contribution.Config["labels"].(map[string]any)
		for locale := range labels {
			if locale != "en" {
				locales[locale] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(locales))
	for locale := range locales {
		result = append(result, locale)
	}
	sort.Strings(result)
	return result
}

// foldContributionLabels adds deprecated config.labels translations the
// catalog does not already have.
func foldContributionLabels(catalog *messageCatalog, manifest Manifest) {
	var folded []catalogEntry
	for _, contribution := range manifest.Contributions {
		label := contributionLabel(contribution, catalog.locale)
		key := "manifest.contribution." + contribution.ID + ".label"
		if _, _, exists := catalog.find(key); label == "" || exists {
			continue
		}
		folded = append(folded, catalogEntry{key: key, message: catalogMessage{text: label}})
	}
	if len(folded) == 0 {
		return
	}
	for index := range catalog.sections {
		if catalog.sections[index].id == ManifestSection {
			catalog.sections[index].entries = append(catalog.sections[index].entries, folded...)
			return
		}
	}
	catalog.sections = append([]catalogSection{{id: ManifestSection, entries: folded}}, catalog.sections...)
}

// localeCatalogs builds every language the package supplies: English always,
// each declared catalog, and any language only contribution labels name.
func (i *Inspector) localeCatalogs(ctx context.Context, manifest Manifest, entries map[string]*zip.File) ([]LocaleCatalog, error) {
	read := func(declared string) ([]byte, error) {
		normalized, err := normalizedPackagePath(declared, false)
		if err != nil {
			return nil, err
		}
		entry, ok := entries[normalized]
		if !ok {
			return nil, fmt.Errorf("declared file %q is missing", normalized)
		}
		if entry.UncompressedSize64 > MaxCatalogBytes {
			return nil, fmt.Errorf("the file is larger than %d bytes", MaxCatalogBytes)
		}
		return readEntry(ctx, entry, MaxCatalogBytes)
	}
	load := func(locale string, english *messageCatalog) (*messageCatalog, []string, error) {
		declared, ok := manifest.Locales[locale]
		if !ok {
			return nil, nil, nil
		}
		body, err := read(declared)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, nil, ctxErr
			}
			return nil, []string{err.Error()}, nil
		}
		catalog, issues, _ := i.checkCatalog(body, locale, english)
		return catalog, issues, nil
	}

	english, englishIssues, err := load("en", nil)
	if err != nil {
		return nil, err
	}
	if english == nil {
		english = &messageCatalog{locale: "en"}
	}
	english.sections = append([]catalogSection{{id: ManifestSection, entries: manifestEntries(manifest)}}, english.sections...)
	result := make([]LocaleCatalog, 0, 1+len(manifest.Locales))
	encoded, err := localeCatalog(english, manifest.Locales["en"], englishIssues)
	if err != nil {
		return nil, err
	}
	result = append(result, encoded)

	locales := map[string]struct{}{}
	for locale := range manifest.Locales {
		if locale != "en" {
			locales[locale] = struct{}{}
		}
	}
	for _, locale := range contributionLabelLocales(manifest) {
		locales[locale] = struct{}{}
	}
	names := make([]string, 0, len(locales))
	for locale := range locales {
		names = append(names, locale)
	}
	sort.Strings(names)
	for _, locale := range names {
		catalog, issues, err := load(locale, english)
		if err != nil {
			return nil, err
		}
		if catalog == nil {
			catalog = &messageCatalog{locale: locale}
		}
		foldContributionLabels(catalog, manifest)
		encoded, err := localeCatalog(catalog, manifest.Locales[locale], issues)
		if err != nil {
			return nil, err
		}
		result = append(result, encoded)
	}
	return result, nil
}

func localeCatalog(catalog *messageCatalog, path string, issues []string) (LocaleCatalog, error) {
	body, err := catalog.encode()
	if err != nil {
		return LocaleCatalog{}, fmt.Errorf("encode %s catalog: %w", catalog.locale, err)
	}
	digest := sha256.Sum256(body)
	sections := make([]string, 0, len(catalog.sections))
	for _, section := range catalog.sections {
		if len(section.entries) > 0 {
			sections = append(sections, section.id)
		}
	}
	bounded := make([]string, 0, min(len(issues), maxCatalogIssues))
	for index, issue := range issues {
		if index == maxCatalogIssues {
			bounded[maxCatalogIssues-1] = fmt.Sprintf("%d more issues", len(issues)-maxCatalogIssues+1)
			break
		}
		if utf8.RuneCountInString(issue) > maxCatalogIssueLength {
			issue = string([]rune(issue)[:maxCatalogIssueLength-1]) + "…"
		}
		bounded = append(bounded, issue)
	}
	if len(bounded) == 0 {
		bounded = nil
	}
	return LocaleCatalog{
		Locale: catalog.locale, Path: path, SHA256: hex.EncodeToString(digest[:]),
		Messages: catalog.messageCount(), Sections: sections, Issues: bounded, body: body,
	}, nil
}
