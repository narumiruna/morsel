ALTER TABLE shares
ADD COLUMN preview_title text,
ADD COLUMN preview_description text;

UPDATE shares
SET preview_title = 'Morsel',
    preview_description = 'Shared with Morsel.'
WHERE preview_enabled;

ALTER TABLE shares
DROP COLUMN preview_enabled,
ADD CONSTRAINT shares_preview_metadata_pair CHECK (
    (preview_title IS NULL) = (preview_description IS NULL)
),
ADD CONSTRAINT shares_preview_title_valid CHECK (
    preview_title IS NULL OR (
        preview_title = btrim(preview_title)
        AND char_length(preview_title) BETWEEN 1 AND 80
    )
),
ADD CONSTRAINT shares_preview_description_valid CHECK (
    preview_description IS NULL OR (
        preview_description = btrim(preview_description)
        AND char_length(preview_description) BETWEEN 1 AND 200
    )
);
