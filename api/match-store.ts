import { neon } from '@neondatabase/serverless';
import { createInitialGame, type GameMode, type GameState } from '../src/game/index.js';

export interface MatchParticipant {
  playerId: string;
  displayName: string;
}

export interface LobbyAcceptance {
  ready: boolean;
  acceptedCount: number;
}

export function expectedPlayersForMode(mode: GameMode): number {
  const expectedSeats: Record<GameMode, number> = {
    'classic-1v1': 2,
    'three-hand-rush': 3,
    'three-hand-qualifier': 3,
    'partners-2v2': 4,
  };
  return expectedSeats[mode];
}

export function createInitialMatchState(participants: MatchParticipant[], mode: GameMode): GameState {
  const orderedParticipants = [...participants]
    .sort((left, right) => left.playerId.localeCompare(right.playerId));
  const expectedSeats = expectedPlayersForMode(mode);
  if (orderedParticipants.length !== expectedSeats) {
    throw new Error(`${mode} requires exactly ${expectedSeats} players.`);
  }
  const state = createInitialGame({ mode });
  orderedParticipants.forEach((participant, index) => {
    state.players[`player-${index + 1}`].name = participant.displayName;
  });
  return state;
}

export function initialLobbyAcceptedPlayerIds(
  participants: MatchParticipant[],
  creatorPlayerId: string,
): string[] {
  const participantIds = new Set(participants.map((participant) => participant.playerId));
  if (!participantIds.has(creatorPlayerId)) {
    throw new Error('The table creator must be one of its players.');
  }
  return [creatorPlayerId];
}

export async function ensureMatchRecord(
  matchId: string,
  participants: MatchParticipant[],
  mode: GameMode = 'classic-1v1',
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured.');

  const orderedParticipants = [...participants]
    .sort((first, second) => first.playerId.localeCompare(second.playerId));
  const state = createInitialMatchState(orderedParticipants, mode);
  const sql = neon(databaseUrl);
  await sql`
    INSERT INTO zulu_casino_matches (match_id, player_one_id, player_two_id, player_ids, seat_player_ids, game_mode, game_state, revision, game_history)
    VALUES (
      ${matchId}, ${orderedParticipants[0].playerId}, ${orderedParticipants[1].playerId},
      ${JSON.stringify(orderedParticipants.map((participant) => participant.playerId))}::jsonb,
      ${JSON.stringify(orderedParticipants.map((participant) => participant.playerId))}::jsonb,
      ${mode}, ${JSON.stringify(state)}::jsonb, ${state.revision}, ${JSON.stringify([state])}::jsonb
    )
    ON CONFLICT (match_id) DO NOTHING
  `;
}

export async function createMatchLobby(
  matchId: string,
  participants: MatchParticipant[],
  mode: GameMode,
  creatorPlayerId: string,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured.');
  const expectedSeats = expectedPlayersForMode(mode);
  if (participants.length !== expectedSeats) throw new Error(`${mode} requires ${expectedSeats} players.`);
  const playerIds = [...new Set(participants.map((participant) => participant.playerId))].sort();
  if (playerIds.length !== expectedSeats) throw new Error('Choose a different account for every seat.');
  const acceptedPlayerIds = initialLobbyAcceptedPlayerIds(participants, creatorPlayerId);
  const sql = neon(databaseUrl);
  await sql`
    INSERT INTO zulu_casino_match_lobbies (match_id, game_mode, participant_ids, accepted_player_ids)
    VALUES (
      ${matchId}, ${mode}, ${JSON.stringify(playerIds)}::jsonb,
      ${JSON.stringify(acceptedPlayerIds)}::jsonb
    )
    ON CONFLICT (match_id) DO NOTHING
  `;
}

export async function acceptMatchLobbyPlayer(matchId: string, playerId: string): Promise<LobbyAcceptance | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured.');
  const sql = neon(databaseUrl);
  const acceptedPlayer = JSON.stringify([playerId]);
  const rows = await sql`
    UPDATE zulu_casino_match_lobbies
    SET accepted_player_ids = CASE
          WHEN accepted_player_ids @> ${acceptedPlayer}::jsonb THEN accepted_player_ids
          ELSE accepted_player_ids || ${acceptedPlayer}::jsonb
        END,
        status = CASE
          WHEN (
            CASE
              WHEN accepted_player_ids @> ${acceptedPlayer}::jsonb THEN accepted_player_ids
              ELSE accepted_player_ids || ${acceptedPlayer}::jsonb
            END
          ) @> participant_ids THEN 'ready'
          ELSE status
        END,
        updated_at = now()
    WHERE match_id = ${matchId}
      AND status = 'waiting'
      AND participant_ids @> ${acceptedPlayer}::jsonb
    RETURNING participant_ids, accepted_player_ids, status
  `;
  const row = rows[0] as { participant_ids: string[]; accepted_player_ids: string[]; status: string } | undefined;
  if (!row) return null;
  return { ready: row.status === 'ready', acceptedCount: row.accepted_player_ids.length };
}

export async function cancelMatchLobby(matchId: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured.');
  const sql = neon(databaseUrl);
  await sql`
    UPDATE zulu_casino_match_lobbies
    SET status = 'cancelled', updated_at = now()
    WHERE match_id = ${matchId} AND status = 'waiting'
  `;
}

export async function isMatchComplete(matchId: string): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured.');
  const sql = neon(databaseUrl);
  const rows = await sql`
    SELECT game_state->>'phase' AS phase
    FROM zulu_casino_matches
    WHERE match_id = ${matchId}
    LIMIT 1
  `;
  return rows[0]?.phase === 'complete';
}
