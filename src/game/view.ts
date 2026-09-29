import { Build, Card, GamePhase, GameScore, GameState, PlayerId, Round } from './types';

export interface PublicPlayerView {
  id: PlayerId;
  name: string;
  handCount: number;
  capturedCount: number | null;
  exposedCapturedCard: Card | null;
}

export interface PublicPendingMoveView {
  playerId: PlayerId;
  mode: GameState['pendingMove'] extends infer _T ? NonNullable<GameState['pendingMove']>['mode'] : never;
  targetValue: number;
  selectedBuildId: string | null;
  resolvedPublicCards: Card[];
  stage: NonNullable<GameState['pendingMove']>['stage'];
  committedHandCardId?: Card['id'];
}

export interface PlayerViewState {
  viewerPlayerId: PlayerId;
  ownHand: Card[];
  players: Record<PlayerId, PublicPlayerView>;
  deckCount: number;
  floor: Card[];
  builds: Build[];
  currentPlayer: PlayerId;
  round: Round;
  phase: GamePhase;
  lastPlayerToCapture: PlayerId | null;
  pendingMove: PublicPendingMoveView | null;
  score: GameScore | null;
  revision: number;
}

export function createPlayerViewState(state: GameState, viewerPlayerId: PlayerId): PlayerViewState {
  if (!state.players[viewerPlayerId]) throw new Error(`Unknown viewing player ${viewerPlayerId}.`);

  const players = Object.fromEntries(
    state.turnOrder.map((playerId) => {
      const player = state.players[playerId];
      const exposed = player.exposedCapturedCardId
        ? player.captured.find((card) => card.id === player.exposedCapturedCardId) ?? null
        : null;
      return [playerId, {
        id: player.id,
        name: player.name,
        handCount: player.hand.length,
        capturedCount: state.phase === 'complete' ? player.captured.length : null,
        exposedCapturedCard: exposed,
      }];
    }),
  );

  return {
    viewerPlayerId,
    ownHand: [...state.players[viewerPlayerId].hand],
    players,
    deckCount: state.deck.length,
    floor: [...state.floor],
    builds: state.builds.map((build) => ({ ...build, orderedCards: [...build.orderedCards] })),
    currentPlayer: state.currentPlayer,
    round: state.round,
    phase: state.phase,
    lastPlayerToCapture: state.lastPlayerToCapture,
    pendingMove: state.pendingMove
      ? {
          playerId: state.pendingMove.playerId,
          mode: state.pendingMove.mode,
          targetValue: state.pendingMove.targetValue,
          selectedBuildId: state.pendingMove.selectedBuildId,
          resolvedPublicCards: [...state.pendingMove.orderedPublicCards],
          stage: state.pendingMove.stage,
          ...(state.pendingMove.playerId === viewerPlayerId
            ? { committedHandCardId: state.pendingMove.reservedHandCardId }
            : {}),
        }
      : null,
    score: state.phase === 'complete' ? state.score : null,
    revision: state.revision,
  };
}
