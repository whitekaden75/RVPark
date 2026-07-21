CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_users_active_username_idx
  ON admin_users (LOWER(username))
  WHERE is_active = TRUE;

-- After generating a salt and hash in your terminal, insert your admin login like this:
-- INSERT INTO admin_users (username, password_salt, password_hash)
-- VALUES ('admin', 'paste_salt_here', 'paste_hash_here');
