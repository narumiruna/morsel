package api

import (
	"bytes"
	"context"
	"encoding/json"
	"math"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

func (h *Service) addMCPTools(server *mcp.Server) {
	text := map[string]any{"type": "string"}
	preview := mcpObject(map[string]any{"title": text, "description": text, "image": text, "locale": text}, "title", "description")
	integer := map[string]any{"type": "integer", "minimum": 1, "maximum": int64(math.MaxInt64)}
	date := map[string]any{"type": "string", "format": "date-time"}
	id := map[string]any{"type": "string", "format": "uuid"}
	errorSchema := mcpObject(map[string]any{"code": text, "message": text}, "code", "message")
	output := func(success map[string]any) map[string]any {
		return map[string]any{"type": "object", "anyOf": []any{success, errorSchema}}
	}
	destructive := true
	addMCPTool(server, &mcp.Tool{
		Name: "create_share", Description: "Create a Markdown share. Anyone with the returned share_url can read it. Do not retrieve the URL to validate it. Creation is not idempotent; do not automatically retry it.",
		InputSchema: mcpObject(map[string]any{
			"content": text, "preview": preview, "telegram_instant_view": map[string]any{"type": "boolean"},
			"expires_in": map[string]any{"type": []string{"integer", "null"}, "minimum": 1, "maximum": 315360000},
			"max_views":  map[string]any{"type": []string{"integer", "null"}, "minimum": 1, "maximum": int64(math.MaxInt64)},
		}, "content"),
		OutputSchema: output(mcpObject(map[string]any{
			"id": id, "share_url": text, "created_at": date, "expires_at": date,
			"max_views": integer, "preview": preview, "telegram_instant_view": map[string]any{"type": "boolean"},
		}, "id", "share_url", "created_at", "telegram_instant_view")),
		Annotations: &mcp.ToolAnnotations{DestructiveHint: new(bool), OpenWorldHint: new(bool)},
	}, func(ctx context.Context, input CreateShareRequest) (any, bool) {
		response, err := h.CreateShare(ctx, CreateShareRequestObject{Body: &input})
		if err == nil {
			switch result := response.(type) {
			case CreateShare201JSONResponse:
				return CreateShareResponse(result), false
			case CreateShare400JSONResponse:
				return Error(result.BadRequestJSONResponse), true
			case CreateShare401JSONResponse:
				return result.Body, true
			case CreateShare413JSONResponse:
				return Error(result.ContentTooLargeJSONResponse), true
			case CreateShare500JSONResponse:
				return Error(result.InternalErrorJSONResponse), true
			}
		}
		return errorResponse(ErrorCodeInternalError, "internal server error"), true
	})

	addMCPTool(server, &mcp.Tool{
		Name: "get_share", Description: "Retrieve a share by its raw capability token, not a URL or administrative UUID. Each successful call consumes one view and can exhaust the share. Use only when retrieval is explicitly requested; do not automatically retry. A valid capability can read a share from any account.",
		InputSchema: mcpObject(map[string]any{"token": text}, "token"),
		OutputSchema: output(mcpObject(map[string]any{
			"content": text, "created_at": date, "expires_at": date, "max_views": integer,
			"view_count":      map[string]any{"type": "integer", "minimum": 0},
			"views_remaining": map[string]any{"type": "integer", "minimum": 0},
		}, "content", "created_at", "view_count")),
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &destructive, OpenWorldHint: new(bool)},
	}, func(ctx context.Context, input struct {
		Token string `json:"token"`
	}) (any, bool) {
		response, err := h.ConsumeShare(ctx, ConsumeShareRequestObject{Share: input.Token})
		if err == nil {
			switch result := response.(type) {
			case ConsumeShare200JSONResponse:
				return result.Body, false
			case ConsumeShare400JSONResponse:
				return Error(result.BadRequestJSONResponse), true
			case ConsumeShare404JSONResponse:
				return Error(result.NotFoundJSONResponse), true
			case ConsumeShare410JSONResponse:
				return Error(result.GoneJSONResponse), true
			case ConsumeShare500JSONResponse:
				return Error(result.InternalErrorJSONResponse), true
			}
		}
		return errorResponse(ErrorCodeInternalError, "internal server error"), true
	})

	type revokeInput struct {
		ID uuid.UUID `json:"id"`
	}
	addMCPTool(server, &mcp.Tool{
		Name: "revoke_share", Description: "Revoke a share by its administrative UUID, not its capability token. Only shares owned by the authenticated account can be revoked. Repeated revocation of an owned share succeeds.",
		InputSchema:  mcpObject(map[string]any{"id": id}, "id"),
		OutputSchema: output(mcpObject(map[string]any{"id": id, "revoked": map[string]any{"const": true}}, "id", "revoked")),
		Annotations:  &mcp.ToolAnnotations{DestructiveHint: &destructive, IdempotentHint: true, OpenWorldHint: new(bool)},
	}, func(ctx context.Context, input revokeInput) (any, bool) {
		response, err := h.RevokeShare(ctx, RevokeShareRequestObject{Share: input.ID})
		if err == nil {
			switch result := response.(type) {
			case RevokeShare204Response:
				return struct {
					ID      uuid.UUID `json:"id"`
					Revoked bool      `json:"revoked"`
				}{input.ID, true}, false
			case RevokeShare400JSONResponse:
				return Error(result.BadRequestJSONResponse), true
			case RevokeShare401JSONResponse:
				return result.Body, true
			case RevokeShare404JSONResponse:
				return Error(result.NotFoundJSONResponse), true
			case RevokeShare500JSONResponse:
				return Error(result.InternalErrorJSONResponse), true
			}
		}
		return errorResponse(ErrorCodeInternalError, "internal server error"), true
	})
}

func mcpObject(properties map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}

// Use the raw SDK API to avoid its generic input decoder's float64 round-trip.
// Decode the original bytes into typed input, then validate the published
// schemas with json.Number so every REST int64 remains exact.
func addMCPTool[Input any](server *mcp.Server, tool *mcp.Tool, call func(context.Context, Input) (any, bool)) {
	inputSchema, outputSchema := compileMCPSchema(tool.InputSchema), compileMCPSchema(tool.OutputSchema)
	server.AddTool(tool, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw := request.Params.Arguments
		// Reject invalid integer encodings and unknown fields before schema
		// arithmetic can expand an attacker-controlled numeric exponent.
		var input Input
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			return mcpToolResult(errorResponse(ErrorCodeInvalidRequest, "invalid tool arguments"), true), nil
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil || inputSchema.Validate(value) != nil {
			return mcpToolResult(errorResponse(ErrorCodeInvalidRequest, "invalid tool arguments"), true), nil
		}
		value, failed := call(ctx, input)
		result := mcpToolResult(value, failed)
		decoded, err := jsonschema.UnmarshalJSON(bytes.NewReader(result.StructuredContent.(json.RawMessage)))
		if err != nil || outputSchema.Validate(decoded) != nil {
			return mcpToolResult(errorResponse(ErrorCodeInternalError, "internal server error"), true), nil
		}
		return result, nil
	})
}

func compileMCPSchema(schema any) *jsonschema.Schema {
	encoded, err := json.Marshal(schema)
	if err != nil {
		panic(err)
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		panic(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	const location = "https://morsel.invalid/mcp-schema"
	if err := compiler.AddResource(location, value); err != nil {
		panic(err)
	}
	return compiler.MustCompile(location)
}

func mcpToolResult(value any, failed bool) *mcp.CallToolResult {
	encoded, err := json.Marshal(value)
	if err != nil {
		encoded = []byte(`{"code":"internal_error","message":"internal server error"}`)
		failed = true
	}
	return &mcp.CallToolResult{
		IsError: failed, StructuredContent: json.RawMessage(encoded),
		Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}},
	}
}
