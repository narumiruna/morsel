package auth

import (
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	oauthScope                  = "mcp:shares"
	oauthOfflineScope           = "mcp:shares offline_access"
	oauthBodyLimit              = 16 * 1024
	oauthAdmissionLock    int64 = 0x6d6f61757468
	oauthMaxClients             = 10000
	oauthMaxRequests            = 10000
	oauthMaxGrants              = 10000
	oauthMaxAccountGrants       = 100
)

// OAuth permits only explicitly supported fields, each with exactly one bounded
// value. Query credentials and query/body merges are never accepted.
func oauthValues(r *http.Request, allowed string, form bool) (url.Values, error) {
	raw := r.URL.RawQuery
	if form {
		if raw != "" || r.URL.ForceQuery || len(r.Header.Values("Authorization")) != 0 {
			return nil, errors.New("invalid form request")
		}
		media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/x-www-form-urlencoded" || (len(params) > 0 && (len(params) != 1 || !strings.EqualFold(params["charset"], "utf-8"))) {
			return nil, errors.New("invalid form media")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		raw = string(body)
	}
	if len(raw) > oauthBodyLimit {
		return nil, errors.New("parameters too large")
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	fields := " " + allowed + " "
	for key, list := range values {
		if !strings.Contains(fields, " "+key+" ") || len(list) != 1 || len(list[0]) > 2048 || !utf8.ValidString(list[0]) || strings.ContainsAny(list[0], "\x00\r\n") {
			return nil, errors.New("invalid parameters")
		}
	}
	return values, nil
}

func canonicalOAuthHandle(raw string) bool {
	if len(raw) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	return err == nil && len(decoded) == 32
}

// Registered native callbacks cannot contain userinfo, queries, fragments,
// escapes, or a wildcard. Only literal loopback IP callbacks may change port.
func oauthRedirect(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\x00\r\n\\*%") {
		return nil, errors.New("invalid redirect")
	}
	for _, b := range []byte(raw) {
		if b < 0x21 || b > 0x7e {
			return nil, errors.New("invalid redirect bytes")
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.RawFragment != "" || strings.Contains(raw, "#") || u.Hostname() == "" || u.Path == "" || !strings.HasPrefix(u.Path, "/") || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery {
		return nil, errors.New("invalid redirect")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1" || u.Hostname() == "localhost")) {
		return nil, errors.New("insecure redirect")
	}
	if u.Host != strings.ToLower(u.Host) || strings.HasSuffix(u.Host, ":") {
		return nil, errors.New("invalid authority")
	}
	if port := u.Port(); port != "" {
		n, e := strconv.ParseUint(port, 10, 16)
		if e != nil || n == 0 || strconv.FormatUint(n, 10) != port {
			return nil, errors.New("invalid port")
		}
	}
	return u, nil
}

func oauthRedirectMatches(registered, requested string) bool {
	a, err := oauthRedirect(registered)
	if err != nil {
		return false
	}
	b, err := oauthRedirect(requested)
	if err != nil {
		return false
	}
	if registered == requested {
		return true
	}
	if a.Scheme != "http" || b.Scheme != "http" || (a.Hostname() != "127.0.0.1" && a.Hostname() != "::1") || a.Hostname() != b.Hostname() {
		return false
	}
	// Compare every remaining URI byte. Do not compare only decoded Path or a
	// hostname suffix, and do not permit an HTTPS-to-HTTP scheme change.
	a.Host = net.JoinHostPort(a.Hostname(), "1")
	b.Host = net.JoinHostPort(b.Hostname(), "1")
	return a.String() == b.String()
}

func oauthScopes(raw string) (string, bool) {
	if raw == oauthScope {
		return oauthScope, true
	}
	if raw == oauthOfflineScope || raw == "offline_access mcp:shares" {
		return oauthOfflineScope, true
	}
	return "", false
}
