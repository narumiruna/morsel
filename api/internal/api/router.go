package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/narumiruna/morsel/api/internal/auth"
	"github.com/narumiruna/morsel/api/internal/telemetry"
)

type RouterConfig struct {
	APIKeys        []string
	AllowedOrigins []string
	MaxRequestBody int64
	RequestTimeout time.Duration
	Logger         *slog.Logger
}

func NewRouter(handler StrictServerInterface, cfg RouterConfig) http.Handler {
	router := chi.NewRouter()
	router.Use(telemetry.RequestLogger(cfg.Logger))
	router.Use(telemetry.Recoverer(cfg.Logger))
	router.Use(telemetry.Timeout(cfg.RequestTimeout))
	router.Use(telemetry.CORS(cfg.AllowedOrigins))
	router.Use(telemetry.BodyLimit(cfg.MaxRequestBody))
	authenticator := auth.New(cfg.APIKeys)
	router.Use(authenticator.Middleware(isProtected))
	router.Use(rejectUnknownCreateFields)

	writeRequestError := func(w http.ResponseWriter, _ *http.Request, err error) {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writePublicError(w, http.StatusRequestEntityTooLarge, ErrorCodeContentTooLarge, "request body is too large")
			return
		}
		writePublicError(w, http.StatusBadRequest, ErrorCodeInvalidRequest, "invalid request")
	}
	strict := NewStrictHandlerWithOptions(handler, nil, StrictHTTPServerOptions{
		RequestErrorHandlerFunc: writeRequestError,
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			requestID := ""
			if info := telemetry.Info(r.Context()); info != nil {
				requestID = info.RequestID
			}
			cfg.Logger.Error("encode response", "request_id", requestID, "error", err)
			writePublicError(w, http.StatusInternalServerError, ErrorCodeInternalError, "internal server error")
		},
	})
	HandlerWithOptions(strict, ChiServerOptions{BaseRouter: router, ErrorHandlerFunc: writeRequestError})
	router.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		writePublicError(w, http.StatusNotFound, ErrorCodeNotFound, "route not found")
	})
	router.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		writePublicError(w, http.StatusMethodNotAllowed, ErrorCodeInvalidRequest, "method not allowed")
	})
	return router
}

func rejectUnknownCreateFields(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/shares" || r.Body == nil {
			next.ServeHTTP(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				writePublicError(w, http.StatusRequestEntityTooLarge, ErrorCodeContentTooLarge, "request body is too large")
			} else {
				writePublicError(w, http.StatusBadRequest, ErrorCodeInvalidRequest, "invalid request")
			}
			return
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		var parsed CreateShareRequest
		if err := decoder.Decode(&parsed); err != nil {
			writePublicError(w, http.StatusBadRequest, ErrorCodeInvalidRequest, "invalid request")
			return
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			writePublicError(w, http.StatusBadRequest, ErrorCodeInvalidRequest, "invalid request")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r)
	})
}

func isProtected(r *http.Request) bool {
	return (r.Method == http.MethodPost && r.URL.Path == "/v1/shares") ||
		(r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/v1/shares/"))
}

func writePublicError(w http.ResponseWriter, status int, code ErrorCode, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorResponse(code, message))
}
