-- NULL means pending backfill. Old servers may continue creating NULL rows.
ALTER TABLE shares ADD COLUMN admin_label text
    CHECK (admin_label IS NULL OR char_length(admin_label) BETWEEN 1 AND 80);
CREATE INDEX shares_pending_admin_labels_idx ON shares (id) WHERE admin_label IS NULL;
