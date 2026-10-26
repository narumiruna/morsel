ALTER TABLE shares
DROP CONSTRAINT shares_preview_image_valid,
DROP CONSTRAINT shares_preview_locale_valid,
DROP COLUMN preview_image,
DROP COLUMN preview_locale;
