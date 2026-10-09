package addonv3

// MaxAddonIDLength is the manifest schema's limit for an add-on ID, in bytes.
const MaxAddonIDLength = 80

// ValidAddonID reports whether value is an add-on ID the manifest schema
// accepts: lowercase letters and digits in words joined by single hyphens,
// starting with a letter, at most MaxAddonIDLength bytes.
func ValidAddonID(value string) bool {
	if len(value) == 0 || len(value) > MaxAddonIDLength || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	hyphen := false
	for index := 1; index < len(value); index++ {
		character := value[index]
		switch {
		case character >= 'a' && character <= 'z' || character >= '0' && character <= '9':
			hyphen = false
		case character == '-' && !hyphen:
			hyphen = true
		default:
			return false
		}
	}
	return !hyphen
}
