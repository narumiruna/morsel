ALTER TABLE shares
ADD COLUMN telegram_instant_view boolean NOT NULL DEFAULT false,
ADD CONSTRAINT shares_telegram_instant_view_valid CHECK (
    NOT telegram_instant_view OR (
        preview_title IS NOT NULL
        AND preview_description IS NOT NULL
        AND expires_at IS NULL
        AND max_views IS NULL
    )
);
