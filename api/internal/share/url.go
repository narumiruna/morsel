package share

import "net/url"

// PublicURL uses the same reader route for creation and owner-supplied links.
func PublicURL(base *url.URL, token string, preview bool) string {
	viewerURL := *base
	if viewerURL.Path == "" {
		viewerURL.Path = "/"
	}
	if preview {
		viewerURL.Path = "/s/" + token
	} else {
		viewerURL.Fragment = "/s/" + token
	}
	return viewerURL.String()
}
