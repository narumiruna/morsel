package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/narumiruna/morsel/api/internal/share"
	"github.com/narumiruna/morsel/api/internal/telemetry"
)

const (
	maxTokenAttempts           = 3
	maxPreviewTitleRunes       = 80
	maxPreviewDescriptionRunes = 200
	maxPreviewImageRunes       = 2048
)

var previewLocalePattern = regexp.MustCompile(`^[a-z]{2,3}_[A-Z]{2}$`)

type Service struct {
	repository       share.Repository
	tokens           share.TokenGenerator
	publicViewerURL  *url.URL
	maxDocumentBytes int64
	logger           *slog.Logger
}

func NewService(repository share.Repository, tokens share.TokenGenerator, publicViewerURL *url.URL, maxDocumentBytes int64, logger *slog.Logger) *Service {
	return &Service{
		repository: repository, tokens: tokens, publicViewerURL: publicViewerURL,
		maxDocumentBytes: maxDocumentBytes, logger: logger,
	}
}

func (h *Service) GetHealth(context.Context, GetHealthRequestObject) (GetHealthResponseObject, error) {
	return GetHealth200JSONResponse{Status: Ok}, nil
}

func (h *Service) GetReadiness(ctx context.Context, _ GetReadinessRequestObject) (GetReadinessResponseObject, error) {
	if err := h.repository.Ping(ctx); err != nil {
		h.logError(ctx, "readiness failed", err)
		return GetReadiness503JSONResponse{ServiceUnavailableJSONResponse: ServiceUnavailableJSONResponse(errorResponse(ErrorCodeServiceUnavailable, "service is not ready"))}, nil
	}
	return GetReadiness200JSONResponse{Status: Ok}, nil
}

func (h *Service) CreateShare(ctx context.Context, request CreateShareRequestObject) (CreateShareResponseObject, error) {
	if request.Body == nil {
		return createBadRequest("request body is required"), nil
	}
	body := request.Body
	if int64(len(body.Content)) > h.maxDocumentBytes {
		return CreateShare413JSONResponse{ContentTooLargeJSONResponse: ContentTooLargeJSONResponse(errorResponse(ErrorCodeContentTooLarge, "Markdown content is too large"))}, nil
	}
	if strings.ContainsRune(body.Content, '\x00') {
		return createBadRequest("content must not contain NUL characters"), nil
	}
	if body.ExpiresIn != nil && (*body.ExpiresIn <= 0 || *body.ExpiresIn > 315360000) {
		return createBadRequest("expires_in must be between 1 and 315360000"), nil
	}
	if body.MaxViews != nil && *body.MaxViews <= 0 {
		return createBadRequest("max_views must be positive"), nil
	}
	preview, validationError := normalizePreview(body.Preview)
	if validationError != "" {
		return createBadRequest(validationError), nil
	}
	telegramInstantView := body.TelegramInstantView != nil && *body.TelegramInstantView
	if telegramInstantView {
		if preview == nil {
			return createBadRequest("telegram_instant_view requires preview"), nil
		}
		if body.ExpiresIn != nil {
			return createBadRequest("telegram_instant_view cannot be combined with expires_in"), nil
		}
		if body.MaxViews != nil {
			return createBadRequest("telegram_instant_view cannot be combined with max_views"), nil
		}
	}

	id := uuid.New()
	for range maxTokenAttempts {
		token, tokenHash, err := h.tokens.Generate()
		if err != nil {
			h.logError(ctx, "generate capability token", err)
			return createInternalError(), nil
		}
		created, err := h.repository.Create(ctx, share.CreateParams{
			ID: id, TokenHash: tokenHash, Content: body.Content,
			ExpiresIn: body.ExpiresIn, MaxViews: body.MaxViews, Preview: preview,
			TelegramInstantView: telegramInstantView,
		})
		if errors.Is(err, share.ErrTokenCollision) {
			continue
		}
		if err != nil {
			h.logError(ctx, "create share", err)
			return createInternalError(), nil
		}
		telemetry.SetShareID(ctx, created.ID.String())
		viewerURL := *h.publicViewerURL
		if created.Preview != nil {
			viewerURL.Path = "/s/" + token
		} else {
			viewerURL.Fragment = "/s/" + token
		}
		return CreateShare201JSONResponse{
			Id: created.ID, ShareUrl: viewerURL.String(), CreatedAt: created.CreatedAt,
			ExpiresAt: created.ExpiresAt, MaxViews: created.MaxViews, Preview: responsePreview(created.Preview),
			TelegramInstantView: created.TelegramInstantView,
		}, nil
	}
	h.logError(ctx, "create share", errors.New("token collision retry limit reached"))
	return createInternalError(), nil
}

func normalizePreview(preview *PreviewMetadata) (*share.PreviewMetadata, string) {
	if preview == nil {
		return nil, ""
	}
	title := strings.TrimSpace(preview.Title)
	description := strings.TrimSpace(preview.Description)
	for _, field := range []struct {
		name  string
		value string
		limit int
	}{
		{name: "preview.title", value: title, limit: maxPreviewTitleRunes},
		{name: "preview.description", value: description, limit: maxPreviewDescriptionRunes},
	} {
		if field.value == "" {
			return nil, field.name + " must not be empty"
		}
		for _, character := range field.value {
			if unicode.IsControl(character) || unicode.In(character, unicode.Zl, unicode.Zp) {
				return nil, field.name + " must not contain control or line-separator characters"
			}
		}
		if utf8.RuneCountInString(field.value) > field.limit {
			return nil, fmt.Sprintf("%s must not exceed %d characters", field.name, field.limit)
		}
	}

	result := &share.PreviewMetadata{Title: title, Description: description}
	if preview.Image != nil {
		result.Image = strings.TrimSpace(*preview.Image)
		parsed, err := url.Parse(result.Image)
		if result.Image == "" {
			return nil, "preview.image must not be empty"
		}
		if utf8.RuneCountInString(result.Image) > maxPreviewImageRunes {
			return nil, fmt.Sprintf("preview.image must not exceed %d characters", maxPreviewImageRunes)
		}
		for _, character := range result.Image {
			if unicode.IsSpace(character) || unicode.IsControl(character) || unicode.In(character, unicode.Zl, unicode.Zp) {
				return nil, "preview.image must not contain whitespace or control characters"
			}
		}
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
			return nil, "preview.image must be an absolute HTTP(S) URL without credentials"
		}
	}
	if preview.Locale != nil {
		result.Locale = strings.TrimSpace(*preview.Locale)
		if !previewLocalePattern.MatchString(result.Locale) {
			return nil, "preview.locale must use language_TERRITORY format"
		}
	}
	return result, ""
}

func responsePreview(preview *share.PreviewMetadata) *PreviewMetadata {
	if preview == nil {
		return nil
	}
	result := &PreviewMetadata{Title: preview.Title, Description: preview.Description}
	if preview.Image != "" {
		result.Image = &preview.Image
	}
	if preview.Locale != "" {
		result.Locale = &preview.Locale
	}
	return result
}

func (h *Service) ConsumeShare(ctx context.Context, request ConsumeShareRequestObject) (ConsumeShareResponseObject, error) {
	tokenHash, err := share.HashToken(request.Share)
	if err != nil {
		return ConsumeShare400JSONResponse{BadRequestJSONResponse: BadRequestJSONResponse(errorResponse(ErrorCodeInvalidRequest, "invalid share token"))}, nil
	}
	consumed, err := h.repository.Consume(ctx, tokenHash)
	if err != nil {
		switch {
		case errors.Is(err, share.ErrNotFound):
			return ConsumeShare404JSONResponse{NotFoundJSONResponse: NotFoundJSONResponse(errorResponse(ErrorCodeNotFound, "share not found"))}, nil
		case errors.Is(err, share.ErrExpired):
			return consumeGone(ErrorCodeExpired, "share has expired"), nil
		case errors.Is(err, share.ErrRevoked):
			return consumeGone(ErrorCodeRevoked, "share has been revoked"), nil
		case errors.Is(err, share.ErrViewLimitExhausted):
			return consumeGone(ErrorCodeViewLimitExhausted, "share view limit is exhausted"), nil
		default:
			h.logError(ctx, "consume share", err)
			return ConsumeShare500JSONResponse{InternalErrorJSONResponse: InternalErrorJSONResponse(errorResponse(ErrorCodeInternalError, "internal server error"))}, nil
		}
	}
	telemetry.SetShareID(ctx, consumed.ID.String())
	cacheControl := "no-store"
	return ConsumeShare200JSONResponse{
		Body: Share{
			Content: consumed.Content, CreatedAt: consumed.CreatedAt, ExpiresAt: consumed.ExpiresAt,
			MaxViews: consumed.MaxViews, ViewCount: consumed.ViewCount, ViewsRemaining: consumed.ViewsRemaining,
		},
		Headers: ConsumeShare200ResponseHeaders{CacheControl: &cacheControl},
	}, nil
}

func (h *Service) RevokeShare(ctx context.Context, request RevokeShareRequestObject) (RevokeShareResponseObject, error) {
	telemetry.SetShareID(ctx, request.Share.String())
	found, err := h.repository.Revoke(ctx, request.Share)
	if err != nil {
		h.logError(ctx, "revoke share", err)
		return RevokeShare500JSONResponse{InternalErrorJSONResponse: InternalErrorJSONResponse(errorResponse(ErrorCodeInternalError, "internal server error"))}, nil
	}
	if !found {
		return RevokeShare404JSONResponse{NotFoundJSONResponse: NotFoundJSONResponse(errorResponse(ErrorCodeNotFound, "share not found"))}, nil
	}
	return RevokeShare204Response{}, nil
}

func (h *Service) logError(ctx context.Context, message string, err error) {
	requestID := ""
	if info := telemetry.Info(ctx); info != nil {
		requestID = info.RequestID
	}
	h.logger.Error(message, "request_id", requestID, "error", err)
}

func errorResponse(code ErrorCode, message string) Error {
	return Error{Code: code, Message: message}
}

func createBadRequest(message string) CreateShare400JSONResponse {
	return CreateShare400JSONResponse{BadRequestJSONResponse: BadRequestJSONResponse(errorResponse(ErrorCodeInvalidRequest, message))}
}

func createInternalError() CreateShare500JSONResponse {
	return CreateShare500JSONResponse{InternalErrorJSONResponse: InternalErrorJSONResponse(errorResponse(ErrorCodeInternalError, "internal server error"))}
}

func consumeGone(code ErrorCode, message string) ConsumeShare410JSONResponse {
	return ConsumeShare410JSONResponse{GoneJSONResponse: GoneJSONResponse(errorResponse(code, message))}
}
