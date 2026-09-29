import { createClerkClient, verifyToken, type User } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  applyGameAction,
  canStartNextRound,
  Card,
  CardId,
  CardValue,
  CaptureCardRef,
  commitPendingMove,
  createInitialGame,
  GameAction,
  GameMode,
  GameState,
  IllegalMoveError,
  resolvePendingPublicGroup,
  startRoundTwo,
} from '../src/game/index.js';
import { ensureMatchRecord, expectedPlayersForMode } from './match-store.js';

interface PlayerSummary {
  playerId: string;
  displayName: string;
  username: string | null;
  imageUrl: string;
}

interface ActiveMatch {
  matchId: string;
  opponent: PlayerSummary;
  participants?: PlayerSummary[];
  mode?: GameMode;
}

interface MatchRow {
  player_one_id: string;
  player_two_id: string;
  player_ids: string[];
  seat_player_ids: string[];
  game_mode: GameMode;
  game_state: GameState;
  revision: number;
  game_history: GameState[] | null;
}

type MatchCommand =
  | { type: 'action'; action: GameAction }
  | { type: 'resolve-public'; refs: CaptureCardRef[]; purpose?: 'primary' | 'extra-capture' | 'additional-build-group' }
  | { type: 'commit' }
  | { type: 'rematch' }
  | { type: 'qualifier-advance' }
  | { type: 'qualifier-return' };

const NETWORK_KEY = 'zuluCasinoNetwork';
const MAX_REPLAY_STATES = 512;

function getClerkClient() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured.');
  return createClerkClient({ secretKey });
}

function playerSummary(user: User): PlayerSummary {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    playerId: user.id,
    displayName: user.username || name || 'Zulu Casino Player',
    username: user.username,
    imageUrl: user.imageUrl,
  };
}

function activeMatchFor(user: User): ActiveMatch | null {
  const value = user.privateMetadata[NETWORK_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const activeMatch = (value as { activeMatch?: ActiveMatch }).activeMatch;
  return activeMatch?.matchId && activeMatch.opponent?.playerId ? activeMatch : null;
}

function remapSeats<T>(value: T, mapping: Record<string, string>): T {
  if (typeof value === 'string') return (mapping[value] ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => remapSeats(item, mapping)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    mapping[key] ?? key,
    remapSeats(item, mapping),
  ])) as T;
}

function seatMapping(seatCount: number, viewerSeatIndex: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: seatCount }, (_, index) => [
    `player-${index + 1}`,
    `player-${(index - viewerSeatIndex + seatCount) % seatCount + 1}`,
  ]));
}

function viewerSeatIndexOf(state: GameState, viewerIsPlayerTwo: boolean | number): number {
  return typeof viewerIsPlayerTwo === 'boolean' ? (viewerIsPlayerTwo ? 1 : 0) : viewerIsPlayerTwo;
}

function hiddenCards(count: number): Card[] {
  return Array.from({ length: count }, (_, index) => {
    const value = (index % 10) + 1 as CardValue;
    const suit = (['clubs', 'diamonds', 'hearts', 'spades'] as const)[Math.floor(index / 10) % 4];
    return { id: `${suit}-${value}` as CardId, suit, value };
  });
}

export function projectGame(state: GameState, viewerSeat: boolean | number, spectator = false) {
  const viewerSeatIndex = viewerSeatIndexOf(state, viewerSeat);
  const perspective = remapSeats(state, seatMapping(state.turnOrder.length, viewerSeatIndex));
  perspective.deck = hiddenCards(perspective.deck.length);
  for (const [playerId, player] of Object.entries(perspective.players)) {
    if (playerId !== 'player-1' || spectator) {
      if (perspective.phase !== 'complete') {
      const exposed = player.captured.at(-1);
      player.captured = [
        ...hiddenCards(Math.max(0, player.captured.length - (exposed ? 1 : 0))),
        ...(exposed ? [exposed] : []),
      ];
      }
      player.hand = hiddenCards(player.hand.length);
    }
  }
  if (perspective.pendingMove && (spectator || perspective.pendingMove.playerId !== 'player-1')) {
    perspective.pendingMove.reservedHandCardId = 'clubs-1' as CardId;
  }
  return { game: perspective, integrityValid: true };
}

export function createRematch(state: GameState): GameState {
  const next = createInitialGame({ mode: state.mode ?? 'classic-1v1' });
  state.turnOrder.forEach((playerId) => {
    next.players[playerId].name = state.players[playerId].name;
  });
  next.revision = state.revision + 1;
  return next;
}

export function advanceQualifierState(
  state: GameState,
  seatPlayerIds: string[],
): { game: GameState; seatPlayerIds: string[] } {
  if (state.mode !== 'three-hand-qualifier' || state.phase !== 'complete' || !state.score) {
    throw new IllegalMoveError('The qualifier can advance only after scoring is complete.');
  }
  if (seatPlayerIds.length !== state.turnOrder.length) {
    throw new Error('Qualifier seats do not match the active player list.');
  }
  if (state.score.isDraw) {
    const game = createInitialGame({ mode: 'three-hand-qualifier' });
    state.turnOrder.forEach((playerId) => {
      game.players[playerId].name = state.players[playerId].name;
    });
    game.revision = state.revision + 1;
    return { game, seatPlayerIds };
  }

  const ranking = [...state.turnOrder].sort(
    (first, second) => state.score!.players[second].total - state.score!.players[first].total,
  );
  const [winnerId, runnerUpId] = ranking;
  const winnerSeat = state.turnOrder.indexOf(winnerId);
  const runnerUpSeat = state.turnOrder.indexOf(runnerUpId);
  const game = createInitialGame({ mode: 'classic-1v1', startingPlayer: 'player-2' });
  game.players['player-1'].name = state.players[winnerId].name;
  game.players['player-2'].name = state.players[runnerUpId].name;
  game.revision = state.revision + 1;
  return {
    game,
    seatPlayerIds: [seatPlayerIds[winnerSeat], seatPlayerIds[runnerUpSeat]],
  };
}

export function returnToQualifierState(
  state: GameState,
  qualifierState: GameState,
  seatPlayerIds: string[],
): GameState {
  if (
    state.phase !== 'complete' ||
    state.mode !== 'classic-1v1' ||
    qualifierState.mode !== 'three-hand-qualifier' ||
    seatPlayerIds.length !== qualifierState.turnOrder.length
  ) throw new IllegalMoveError('The completed playoff cannot return to its qualifier table.');
  const next = createInitialGame({ mode: 'three-hand-qualifier' });
  qualifierState.turnOrder.forEach((playerId) => {
    next.players[playerId].name = qualifierState.players[playerId].name;
  });
  next.revision = state.revision + 1;
  return next;
}

export function latestCompletedGame(history: GameState[]): GameState[] {
  let completedIndex = -1;
  let previousCompletedIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].phase !== 'complete') continue;
    if (completedIndex < 0) completedIndex = index;
    else {
      previousCompletedIndex = index;
      break;
    }
  }
  return completedIndex < 0
    ? []
    : history.slice(previousCompletedIndex + 1, completedIndex + 1);
}

export function projectReplay(state: GameState, viewerSeat: boolean | number): GameState {
  return remapSeats(state, seatMapping(state.turnOrder.length, viewerSeatIndexOf(state, viewerSeat)));
}

function jsonBody(request: VercelRequest): Record<string, unknown> {
  if (typeof request.body === 'string') return JSON.parse(request.body) as Record<string, unknown>;
  return (request.body ?? {}) as Record<string, unknown>;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const databaseUrl = process.env.DATABASE_URL;
    const secretKey = process.env.CLERK_SECRET_KEY;
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || !secretKey) return response.status(401).json({ error: 'Sign in to open this match.' });
    if (!databaseUrl) return response.status(503).json({ error: 'Online matches are not configured yet.' });

    const payload = await verifyToken(token, { secretKey });
    const clerk = getClerkClient();
    const currentUser = await clerk.users.getUser(payload.sub);
    const activeMatch = activeMatchFor(currentUser);
    const matchId = typeof request.query.matchId === 'string' ? request.query.matchId : '';
    if (!activeMatch || activeMatch.matchId !== matchId) {
      return response.status(403).json({ error: 'This match is not active for your account.' });
    }

    const participantSummaries = activeMatch.participants?.length
      ? activeMatch.participants
      : [playerSummary(currentUser), activeMatch.opponent];
    const participantIds = [...new Set(participantSummaries.map((participant) => participant.playerId))].sort();
    const mode = activeMatch.mode ?? (
      participantIds.length === 4 ? 'partners-2v2' : participantIds.length === 3 ? 'three-hand-rush' : 'classic-1v1'
    );
    if (!participantIds.includes(currentUser.id) || participantIds.length !== expectedPlayersForMode(mode)) {
      return response.status(403).json({ error: 'This table has an invalid player roster.' });
    }

    const participantUsers = await Promise.all(participantIds.map((id) => (
      id === currentUser.id ? currentUser : clerk.users.getUser(id)
    )));
    for (const participant of participantUsers) {
      const participantMatch = activeMatchFor(participant);
      const participantRoster = participantMatch?.participants?.length
        ? participantMatch.participants.map((entry) => entry.playerId).sort()
        : participantMatch?.opponent?.playerId
          ? [participant.id, participantMatch.opponent.playerId].sort()
          : [];
      if (
        participantMatch?.matchId !== matchId ||
        participantRoster.length !== participantIds.length ||
        participantRoster.some((id, index) => id !== participantIds[index])
      ) return response.status(403).json({ error: 'Every table player must be ready.' });
    }

    const participants = participantUsers
      .map(playerSummary)
      .sort((first, second) => first.playerId.localeCompare(second.playerId));
    const playerOne = participantUsers.find((player) => player.id === participantIds[0])!;
    const playerTwo = participantUsers.find((player) => player.id === participantIds[1])!;
    const sql = neon(databaseUrl);

    if (request.method === 'GET') {
      await ensureMatchRecord(matchId, participants, mode);
      const rows = await sql`
        SELECT player_one_id, player_two_id, player_ids, seat_player_ids, game_mode, game_state, revision, game_history
        FROM zulu_casino_matches WHERE match_id = ${matchId}
      `;
      const row = rows[0] as MatchRow | undefined;
      if (
        !row || row.player_one_id !== playerOne.id || row.player_two_id !== playerTwo.id ||
        row.game_mode !== mode || row.player_ids.length !== participantIds.length ||
        row.player_ids.some((id, index) => id !== participantIds[index])
      ) {
        return response.status(409).json({ error: 'This match ID belongs to a different player pair.' });
      }
      const activeSeatIds = row.seat_player_ids?.length ? row.seat_player_ids : row.player_ids;
      const actualSeatIndex = activeSeatIds.indexOf(currentUser.id);
      const spectator = actualSeatIndex < 0;
      const viewerSeatIndex = spectator ? 0 : actualSeatIndex;
      const replay = request.query.replay === '1'
        ? latestCompletedGame(row.game_history ?? []).map((state) => projectReplay(state, viewerSeatIndex))
        : undefined;
      return response.status(200).json({
        matchId,
        ...projectGame(row.game_state, viewerSeatIndex, spectator),
        spectator,
        ...(replay ? { replay } : {}),
      });
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      return response.status(405).json({ error: 'Method not allowed.' });
    }

    const body = jsonBody(request);
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || !body.command || typeof body.command !== 'object') {
      return response.status(400).json({ error: 'A revision and valid move command are required.' });
    }
    const rows = await sql`
      SELECT player_one_id, player_two_id, player_ids, seat_player_ids, game_mode, game_state, revision, game_history
      FROM zulu_casino_matches WHERE match_id = ${matchId}
    `;
    const row = rows[0] as MatchRow | undefined;
    if (
      !row || row.player_one_id !== playerOne.id || row.player_two_id !== playerTwo.id ||
      row.game_mode !== mode || row.player_ids.length !== participantIds.length ||
      row.player_ids.some((id, index) => id !== participantIds[index])
    ) {
      return response.status(404).json({ error: 'The online table has not been created.' });
    }
    const currentState = row.game_state;
    const activeSeatIds = row.seat_player_ids?.length ? row.seat_player_ids : row.player_ids;
    const actualSeatIndex = activeSeatIds.indexOf(currentUser.id);
    const spectator = actualSeatIndex < 0;
    const viewerSeatIndex = spectator ? 0 : actualSeatIndex;
    const command = body.command as MatchCommand;
    if (spectator && command.type !== 'qualifier-advance') {
      if (command.type !== 'qualifier-return') {
        return response.status(403).json({ error: 'A spectator cannot submit a game move.' });
      }
    }
    if (row.revision !== expectedRevision) {
      return response.status(409).json({
        error: 'The table changed before that move arrived. The latest table has been loaded.',
        ...projectGame(currentState, viewerSeatIndex, spectator),
        spectator,
      });
    }

    let canonicalNext: GameState;
    let nextSeatPlayerIds = activeSeatIds;
    if (command.type === 'qualifier-advance') {
      const advanced = advanceQualifierState(currentState, activeSeatIds);
      canonicalNext = advanced.game;
      nextSeatPlayerIds = advanced.seatPlayerIds;
    } else if (command.type === 'qualifier-return') {
      if (row.game_mode !== 'three-hand-qualifier') {
        return response.status(409).json({ error: 'This table is not a qualifier match.' });
      }
      const qualifierState = [...(row.game_history ?? [])]
        .reverse()
        .find((state) => state.mode === 'three-hand-qualifier');
      if (!qualifierState) return response.status(409).json({ error: 'Qualifier history is unavailable.' });
      canonicalNext = returnToQualifierState(currentState, qualifierState, row.player_ids);
      nextSeatPlayerIds = row.player_ids;
    } else {
      const toViewerSeats = seatMapping(currentState.turnOrder.length, viewerSeatIndex);
      const toCanonicalSeats = Object.fromEntries(Object.entries(toViewerSeats).map(([canonical, local]) => [local, canonical]));
      const callerState = remapSeats(currentState, toViewerSeats);
      let next: GameState;
      if (command.type === 'action') {
        if (command.action?.playerId !== 'player-1') {
          return response.status(403).json({ error: 'A player can only submit a move for their own seat.' });
        }
        next = applyGameAction(callerState, command.action);
      } else if (command.type === 'resolve-public') {
        next = resolvePendingPublicGroup(callerState, 'player-1', command.refs, command.purpose);
      } else if (command.type === 'commit') {
        next = commitPendingMove(callerState, 'player-1');
      } else if (command.type === 'rematch') {
        if (callerState.phase !== 'complete') {
          return response.status(409).json({
            error: 'A rematch is available after the current game is complete.',
            ...projectGame(currentState, viewerSeatIndex, spectator),
            spectator,
          });
        }
        next = createRematch(callerState);
      } else {
        return response.status(400).json({ error: 'Unknown move command.' });
      }
      if (canStartNextRound(next)) next = startRoundTwo(next);
      canonicalNext = remapSeats(next, toCanonicalSeats);
    }
    const gameHistory = [
      ...(Array.isArray(row.game_history) && row.game_history.length ? row.game_history : [currentState]),
      canonicalNext,
    ].slice(-MAX_REPLAY_STATES);
    const updated = await sql`
      UPDATE zulu_casino_matches
      SET game_state = ${JSON.stringify(canonicalNext)}::jsonb,
          revision = ${canonicalNext.revision},
          seat_player_ids = ${JSON.stringify(nextSeatPlayerIds)}::jsonb,
          game_history = ${JSON.stringify(gameHistory)}::jsonb,
          updated_at = now()
      WHERE match_id = ${matchId} AND revision = ${expectedRevision}
      RETURNING revision
    `;
    if (updated.length === 0) {
      const latestRows = await sql`SELECT game_state FROM zulu_casino_matches WHERE match_id = ${matchId}`;
      const latest = latestRows[0] as { game_state: GameState } | undefined;
      return response.status(409).json({
        error: 'The table changed before that move arrived. The latest table has been loaded.',
        ...(latest ? projectGame(latest.game_state, viewerSeatIndex, spectator) : {}),
        spectator,
      });
    }
    const nextSeatIndex = nextSeatPlayerIds.indexOf(currentUser.id);
    const nextSpectator = nextSeatIndex < 0;
    return response.status(200).json({
      matchId,
      ...projectGame(canonicalNext, nextSpectator ? 0 : nextSeatIndex, nextSpectator),
      spectator: nextSpectator,
    });
  } catch (error) {
    console.error('Online match error', error);
    if (error instanceof IllegalMoveError) {
      return response.status(400).json({ error: error.message });
    }
    return response.status(500).json({
      error: 'The online match service is temporarily unavailable.',
    });
  }
}