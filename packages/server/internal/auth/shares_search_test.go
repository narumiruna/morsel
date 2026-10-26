package auth

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/packages/server/internal/share"
)

func TestParseShareSortQuery(t *testing.T) {
	for _, sort := range []string{"newest", "oldest", "most_views", "least_views"} {
		p, err := parseShareQuery(httptest.NewRequest("GET", "/v1/account/shares?sort="+sort+"&q=+target+&status=active", nil))
		if err != nil || p.Sort != sort || p.Q != "target" || p.Status != "active" || p.Limit != 25 {
			t.Fatalf("sort=%s: %+v %v", sort, p, err)
		}
	}
	for _, query := range []string{"sort=", "sort=views", "sort=MOST_VIEWS", "sort=most_views&sort=least_views", "sort=least_views&sort=least_views"} {
		if _, err := parseShareQuery(httptest.NewRequest("GET", "/v1/account/shares?"+query, nil)); err == nil {
			t.Fatalf("accepted %s", query)
		}
	}
	p, err := parseShareQuery(httptest.NewRequest("GET", "/v1/account/shares", nil))
	if err != nil || p.Sort != "newest" {
		t.Fatalf("default: %+v %v", p, err)
	}
}

func TestAccountShareSearchValidationAndAuthorization(t *testing.T) {
	s, pool := testService(t)
	b := enroll(t, s, pool)
	for _, query := range []string{
		"q=" + url.QueryEscape(strings.Repeat("界", 101)), "q=a&q=b", "q=&q=", "q=%FF",
		"sort=", "sort=NEWEST", "sort=invalid", "sort=newest&sort=oldest", "sort=newest&sort=newest",
	} {
		w := b.request("GET", "/v1/account/shares?"+query, nil)
		requireStatus(t, w, 400)
		assertShareNoStore(t, w)
		// Bad search input cannot reveal management behavior without a session.
		w = newBrowser(s).request("GET", "/v1/account/shares?"+query, nil)
		requireStatus(t, w, 401)
	}
	for _, query := range []string{"q=", "q=%E3%80%80", "q=" + url.QueryEscape(" \u3000"+strings.Repeat("界", 100)+"\u00a0 "), "q=%25_%5C", "q=%00", "sort=oldest", "sort=newest", "sort=most_views", "sort=least_views"} {
		w := b.request("GET", "/v1/account/shares?"+query, nil)
		requireStatus(t, w, 200)
		assertShareNoStore(t, w)
		var page share.AdminPage
		if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || page.MatchingCount != 0 || len(page.Items) != 0 {
			t.Fatalf("empty matching count: %s %v", w.Body.String(), err)
		}
	}
	// An older writer creates pending labels after migration. Do not expose
	// partial counts or let a Bearer key bypass session authentication.
	id := uuid.New()
	if _, err := pool.Exec(t.Context(), `INSERT INTO shares(account_id,id,token_hash,content) VALUES((SELECT id FROM accounts),$1,$2,'# Éclair % _')`, id, randomBytes(32)); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/account/shares?q=absent", "/v1/account/shares/" + id.String()} {
		w := b.request("GET", path, nil)
		requireStatus(t, w, 503)
		assertShareNoStore(t, w)
		if !strings.Contains(w.Body.String(), "label_backfill_required") {
			t.Fatal(w.Body.String())
		}
		requireStatus(t, newBrowser(s).request("GET", path, nil), 401)
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+randomToken())
		r.Header.Set("Origin", s.origin)
		w = httptest.NewRecorder()
		s.ServeHTTP(w, r)
		requireStatus(t, w, 401)
	}
	if _, err := share.BackfillLabels(t.Context(), pool, 1); err != nil {
		t.Fatal(err)
	}
	w := b.request("GET", "/v1/account/shares?q="+url.QueryEscape(" éclair ")+"&sort=oldest", nil)
	requireStatus(t, w, 200)
	var page share.AdminPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || page.MatchingCount != 1 || len(page.Items) != 1 || page.Items[0].Label != "Éclair % _" {
		t.Fatalf("search: %s %v", w.Body.String(), err)
	}
}
