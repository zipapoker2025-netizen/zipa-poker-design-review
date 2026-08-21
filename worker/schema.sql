-- ZIPA POKER design review — one row per (voter, section).
-- Re-running this file is safe; it never drops existing rows.
CREATE TABLE IF NOT EXISTS votes (
  voter   TEXT NOT NULL,
  section TEXT NOT NULL,
  choice  TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL,
  PRIMARY KEY (voter, section)
);
CREATE INDEX IF NOT EXISTS votes_by_section ON votes (section);
