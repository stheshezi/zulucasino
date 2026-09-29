export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;

export type Suit = (typeof SUITS)[number];
export type CardValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type CardId = `${Suit}-${CardValue}`;
export type PlayerId = string;
export type TeamId = string;
export type BuildId = string;
export type Round = 1 | 2;
export type GamePhase = 'round-1' | 'round-2' | 'complete';
export type GameMode = 'classic-1v1' | 'three-hand-rush' | 'three-hand-qualifier' | 'partners-2v2';

export interface Card {
  id: CardId;
  suit: Suit;
  value: CardValue;
}

export interface Player {
  id: PlayerId;
  name: string;
  hand: Card[];
  captured: Card[];
  exposedCapturedCardId: CardId | null;
}

export interface Build {
  id: BuildId;
  targetValue: CardValue;
  ownerPlayerId: PlayerId;
  ownerTeamId?: TeamId;
  tablePlayerId?: PlayerId;
  secured: boolean;
  orderedCards: Card[];
  createdInRound: Round;
}

export type PendingMoveMode =
  | 'capture'
  | 'normal-build'
  | 'stay'
  | 'continue-build'
  | 'manipulate-build'
  | 'secure-build';

export interface PendingMoveGroup {
  purpose: 'primary' | 'extra-capture' | 'additional-build-group';
  orderedCardIds: CardId[];
}

export interface PendingMove {
  id: number;
  playerId: PlayerId;
  mode: PendingMoveMode;
  targetValue: CardValue;
  reservedHandCardId: CardId;
  selectedBuildId: BuildId | null;
  orderedPublicCards: Card[];
  groups: PendingMoveGroup[];
  stage: 'declared' | 'resolving-public-cards' | 'awaiting-hand-commit';
  startedInRound: Round;
}

export interface ScoreBreakdown {
  aces: number;
  tenOfDiamonds: number;
  twoOfSpades: number;
  spades: number;
  cards: number;
  total: number;
}

export interface GameScore {
  players: Record<PlayerId, ScoreBreakdown>;
  winnerPlayerId: PlayerId;
  teams?: Record<TeamId, ScoreBreakdown>;
  winnerTeamId?: TeamId;
  isDraw?: boolean;
  combinedPoints: number;
}

export interface GameState {
  mode?: GameMode;
  playerTeams?: Record<PlayerId, TeamId>;
  deck: Card[];
  floor: Card[];
  players: Record<PlayerId, Player>;
  builds: Build[];
  nextBuildSequence: number;
  nextPendingMoveSequence: number;
  pendingMove: PendingMove | null;
  turnOrder: PlayerId[];
  currentPlayer: PlayerId;
  round: Round;
  phase: GamePhase;
  lastPlayerToCapture: PlayerId | null;
  lastPlayerToFinishRoundOne: PlayerId | null;
  score: GameScore | null;
  revision: number;
}

export interface BeginMoveInput {
  playerId: PlayerId;
  mode: PendingMoveMode;
  reservedHandCardId: CardId;
  targetValue: CardValue;
  selectedBuildId?: BuildId;
}

export type BuildCardRef =
  | { source: 'hand'; cardId: CardId }
  | { source: 'floor'; cardId: CardId }
  | { source: 'exposed'; playerId: PlayerId; cardId: CardId };

export type CaptureCardRef =
  | { source: 'floor'; cardId: CardId }
  | { source: 'exposed'; playerId: PlayerId; cardId: CardId };

export type CaptureGroup =
  | { type: 'cards'; cards: CaptureCardRef[] }
  | { type: 'build'; buildId: BuildId };

export type GameAction =
  | { type: 'drop'; playerId: PlayerId; cardId: CardId }
  | {
      type: 'partner-stay';
      playerId: PlayerId;
      partnerPlayerId: PlayerId;
      buildId: BuildId;
      cardId: CardId;
    }
  | {
      type: 'create-build';
      playerId: PlayerId;
      playedCardId: CardId;
      floorCardIds: CardId[];
      additionalFloorGroups?: CardId[][];
      publicCards?: CaptureCardRef[];
      additionalPublicGroups?: CaptureCardRef[][];
      targetValue: CardValue;
    }
  | {
      type: 'manipulate-build';
      playerId: PlayerId;
      buildId: BuildId;
      cards: BuildCardRef[];
      newTargetValue: CardValue;
    }
  | {
      type: 'secure-build';
      playerId: PlayerId;
      buildId: BuildId;
      cardId: CardId;
      publicGroups?: CaptureCardRef[][];
    }
  | {
      type: 'stay-build';
      playerId: PlayerId;
      playedCardId: CardId;
      floorCardIds: CardId[];
    }
  | {
      type: 'continue-build';
      playerId: PlayerId;
      buildId: BuildId;
      cards: BuildCardRef[];
      additionalPublicGroups?: CaptureCardRef[][];
    }
  | {
      type: 'capture';
      playerId: PlayerId;
      playedCardId: CardId;
      groups: CaptureGroup[];
    };

export interface DealOptions {
  mode?: GameMode;
  cutIndex?: number;
  random?: () => number;
  startingPlayer?: PlayerId;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
