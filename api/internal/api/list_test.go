package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
)

func TestListSharesAuthentication(t *testing.T) {
	for _, header := range []string{"", "Bearer invalid", "bearer " + testAPIKey, "Bearer " + testAPIKey + " extra"} {
		repository := &repositoryStub{}
		handler := testRouter(t, repository, nil, nil, 100)
		// Authentication must run before query parsing.
		response := request(t, handler, http.MethodGet, "/v1/shares?limit=invalid", "", header)
		if response.Code != http.StatusUnauthorized || response.Header().Get("Cache-Control") != "no-store" ||
			response.Header().Get("WWW-Authenticate") == "" || !strings.Contains(response.Body.String(), "unauthorized") ||
			len(repository.listCalls) != 0 || repository.consumeCalls != 0 {
			t.Fatalf("header=%q status=%d headers=%v body=%s calls=%v", header, response.Code, response.Header(), response.Body.String(), repository.listCalls)
		}
	}
}

func TestListSharesQueryValidation(t *testing.T) {
	for _, query := range []string{
		"limit=0", "limit=-1", "limit=101", "limit=2147483648", "limit=999999999999999999999",
		"limit=text", "limit=1.5", "limit=", "offset=-1", "offset=-2147483649",
		"offset=2147483648", "offset=999999999999999999999", "offset=text", "offset=1.5", "offset=",
	} {
		t.Run(query, func(t *testing.T) {
			repository := &repositoryStub{}
			handler := testRouter(t, repository, nil, nil, 100)
			response := request(t, handler, http.MethodGet, "/v1/shares?"+query, "", "Bearer "+testAPIKey)
			if response.Code != http.StatusBadRequest || response.Header().Get("Cache-Control") != "no-store" ||
				!strings.Contains(response.Body.String(), "invalid_request") || len(repository.listCalls) != 0 {
				t.Fatalf("status=%d headers=%v body=%s calls=%v", response.Code, response.Header(), response.Body.String(), repository.listCalls)
			}
		})
	}
}

func TestListSharesPagination(t *testing.T) {
	for _, test := range []struct {
		name       string
		query      string
		count      int
		fetchLimit int32
		offset     int32
		wantItems  int
		wantNext   int64
	}{
		{name: "empty defaults", fetchLimit: 51},
		{name: "default lookahead", count: 51, fetchLimit: 51, wantItems: 50, wantNext: 50},
		{name: "maximum limit", query: "?limit=100", count: 101, fetchLimit: 101, wantItems: 100, wantNext: 100},
		{name: "offset lookahead", query: "?limit=2&offset=7", count: 3, fetchLimit: 3, offset: 7, wantItems: 2, wantNext: 9},
		{name: "exact last page", query: "?limit=2&offset=7", count: 2, fetchLimit: 3, offset: 7, wantItems: 2},
		{name: "partial last page", query: "?limit=2&offset=7", count: 1, fetchLimit: 3, offset: 7, wantItems: 1},
		{name: "past last page", query: "?offset=10", fetchLimit: 51, offset: 10},
		{name: "int32 maximum offset", query: "?limit=1&offset=2147483647", fetchLimit: 2, offset: 2147483647},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &repositoryStub{listResults: make([]share.Summary, test.count)}
			for i := range repository.listResults {
				repository.listResults[i] = share.Summary{ID: uuid.New(), Status: "active"}
			}
			handler := testRouter(t, repository, nil, nil, 100)
			response := request(t, handler, http.MethodGet, "/v1/shares"+test.query, "", "Bearer "+testAPIKey)
			if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
			}
			var body ListSharesResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Items == nil || len(body.Items) != test.wantItems {
				t.Fatalf("items=%+v, want %d items in a JSON array", body.Items, test.wantItems)
			}
			for i, item := range body.Items {
				if item.Id != repository.listResults[i].ID {
					t.Fatal("summary order changed")
				}
			}
			if test.wantNext == 0 {
				if strings.Contains(response.Body.String(), "next_offset") {
					t.Fatalf("unexpected next_offset: %s", response.Body.String())
				}
			} else if body.NextOffset == nil || *body.NextOffset != test.wantNext {
				t.Fatalf("next_offset=%v, want %d", body.NextOffset, test.wantNext)
			}
			if !reflect.DeepEqual(repository.listCalls, [][2]int32{{test.fetchLimit, test.offset}}) || repository.consumeCalls != 0 {
				t.Fatalf("list calls=%v consume calls=%d", repository.listCalls, repository.consumeCalls)
			}
		})
	}
}

func TestListSharesSummaryResponse(t *testing.T) {
	createdAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	expiresAt, revokedAt := createdAt.Add(time.Hour), createdAt.Add(time.Minute)
	maxViews := int64(3)
	repository := &repositoryStub{}
	for _, status := range []string{"active", "revoked", "expired", "view_limit_exhausted"} {
		repository.listResults = append(repository.listResults, share.Summary{
			ID: uuid.New(), Title: "分享標題", Excerpt: strings.Repeat("界🙂", 80),
			CreatedAt: createdAt, ExpiresAt: &expiresAt, MaxViews: &maxViews,
			ViewCount: 2, RevokedAt: &revokedAt, Status: status,
		})
	}
	handler := testRouter(t, repository, nil, nil, 100)
	response := request(t, handler, http.MethodGet, "/v1/shares", "", "Bearer "+testAPIKey)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != len(repository.listResults) {
		t.Fatalf("items=%v", body.Items)
	}
	for i, item := range body.Items {
		source := repository.listResults[i]
		want := map[string]any{
			"id": source.ID.String(), "title": source.Title, "excerpt": source.Excerpt,
			"created_at": createdAt.Format(time.RFC3339), "expires_at": expiresAt.Format(time.RFC3339),
			"max_views": float64(maxViews), "view_count": float64(2), "revoked_at": revokedAt.Format(time.RFC3339), "status": source.Status,
		}
		// Exact keys also exclude full content, capabilities, hashes, and URLs.
		if !reflect.DeepEqual(item, want) {
			t.Fatalf("item=%v, want %v", item, want)
		}
	}
}

func TestListSharesSummaryDefaults(t *testing.T) {
	id := uuid.New()
	createdAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	repository := &repositoryStub{listResults: []share.Summary{{ID: id, CreatedAt: createdAt, Status: "active"}}}
	handler := testRouter(t, repository, nil, nil, 100)
	response := request(t, handler, http.MethodGet, "/v1/shares", "", "Bearer "+testAPIKey)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"items": []any{map[string]any{
		"id": id.String(), "title": "", "excerpt": "", "created_at": createdAt.Format(time.RFC3339),
		"view_count": float64(0), "status": "active",
	}}}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("body=%v want=%v", body, want)
	}
}

func TestListSharesRepositoryError(t *testing.T) {
	logs := &strings.Builder{}
	repository := &repositoryStub{listError: errors.New("database unavailable")}
	handler := testRouter(t, repository, nil, logs, 100)
	response := request(t, handler, http.MethodGet, "/v1/shares", "", "Bearer "+testAPIKey)
	if response.Code != http.StatusInternalServerError || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	var body Error
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != ErrorCodeInternalError || body.Message != "internal server error" ||
		strings.Contains(response.Body.String(), "database unavailable") || !strings.Contains(logs.String(), "list shares") ||
		strings.Contains(logs.String(), testAPIKey) || repository.consumeCalls != 0 {
		t.Fatalf("body=%+v logs=%s consume calls=%d", body, logs, repository.consumeCalls)
	}
}
