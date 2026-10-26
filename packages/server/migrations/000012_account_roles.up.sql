ALTER TABLE accounts ADD COLUMN role text NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin', 'user'));

UPDATE accounts SET role = 'admin'
WHERE id = (SELECT id FROM accounts ORDER BY created_at, id LIMIT 1);
