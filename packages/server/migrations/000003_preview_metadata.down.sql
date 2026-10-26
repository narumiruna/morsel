ALTER TABLE shares
ADD COLUMN preview_enabled boolean NOT NULL DEFAULT false;

UPDATE shares
SET preview_enabled = true
WHERE preview_title IS NOT NULL
  AND preview_description IS NOT NULL;

ALTER TABLE shares
DROP COLUMN preview_title,
DROP COLUMN preview_description;
