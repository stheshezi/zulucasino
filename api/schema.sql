CREATE TABLE IF NOT EXISTS zulu_casino_matches (
  match_id TEXT PRIMARY KEY,
  player_one_id TEXT NOT NULL,
  player_two_id TEXT NOT NULL,
  player_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  seat_player_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  game_mode TEXT NOT NULL DEFAULT 'classic-1v1',
  game_state JSONB NOT NULL,
  game_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (player_one_id <> player_two_id)
);

ALTER TABLE zulu_casino_matches
  ADD COLUMN IF NOT EXISTS game_history JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE zulu_casino_matches
  ADD COLUMN IF NOT EXISTS player_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE zulu_casino_matches
  ADD COLUMN IF NOT EXISTS game_mode TEXT NOT NULL DEFAULT 'classic-1v1';

ALTER TABLE zulu_casino_matches
  ADD COLUMN IF NOT EXISTS seat_player_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE zulu_casino_matches
SET player_ids = jsonb_build_array(player_one_id, player_two_id),
  seat_player_ids = jsonb_build_array(player_one_id, player_two_id),
    game_mode = COALESCE(game_state->>'mode', 'classic-1v1')
WHERE player_ids = '[]'::jsonb OR seat_player_ids = '[]'::jsonb;

CREATE TABLE IF NOT EXISTS zulu_casino_match_lobbies (
  match_id TEXT PRIMARY KEY,
  game_mode TEXT NOT NULL,
  participant_ids JSONB NOT NULL,
  accepted_player_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'ready', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

UPDATE zulu_casino_matches
SET game_history = jsonb_build_array(game_state)
WHERE game_history = '[]'::jsonb;