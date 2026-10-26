ALTER TABLE shares
ADD COLUMN preview_image text,
ADD COLUMN preview_locale text,
ADD CONSTRAINT shares_preview_image_valid CHECK (
    preview_image IS NULL OR (
        preview_title IS NOT NULL
        AND preview_image = btrim(preview_image)
        AND char_length(preview_image) BETWEEN 1 AND 2048
        AND preview_image !~ '[[:space:][:cntrl:]]'
        AND preview_image ~ '^https?://(\[[^]]+\]|[^/?#:@]+)(:[0-9]+)?([/?#].*)?$'
    )
),
ADD CONSTRAINT shares_preview_locale_valid CHECK (
    preview_locale IS NULL OR (
        preview_title IS NOT NULL
        AND preview_locale ~ '^[a-z]{2,3}_[A-Z]{2}$'
    )
);
