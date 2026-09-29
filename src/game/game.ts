import { createDeck, cutDeck, shuffleDeck } from './deck';
import { isRoundDealValid } from './rules';
import { applyGameAction } from './actions';
import { assertValidGameState } from './validation';
import { Card, DealOptions, GameMode, GameState, Player, PlayerId, Round } from './types';

const HAND_SIZE = 10;
const MAX_DEAL_ATTEMPTS = 1_000;

function createPlayer(id: PlayerId, name: string): Player {
  return { id, name, hand: [], captured: [], exposedCapturedCardId: null };
}

function dealHands(
  deck: readonly Card[],
  playerIds: readonly PlayerId[],
  handSize = HAND_SIZE,
): { hands: Record<PlayerId, Card[]>; deck: Card[] } {
  const hands = Object.fromEntries(playerIds.map((playerId) => [playerId, [] as Card[]]));
  const remainingDeck = [...deck];

  for (let index = 0; index < handSize; index += 1) {
    for (const playerId of playerIds) {
      const card = remainingDeck.shift();
      if (!card) throw new Error('Not enough cards to deal every hand.');
      hands[playerId].push(card);
    }
  }

  return { hands, deck: remainingDeck };
}

function modePlayers(mode: GameMode): PlayerId[] {
  if (mode === 'classic-1v1') return ['player-1', 'player-2'];
  if (mode === 'partners-2v2') return ['player-1', 'player-2', 'player-3', 'player-4'];
  return ['player-1', 'player-2', 'player-3'];
}

function playerTeams(mode: GameMode, playerIds: PlayerId[]): Record<PlayerId, string> | undefined {
  if (mode !== 'partners-2v2') return undefined;
  return Object.fromEntries(playerIds.map((id, index) => [id, index % 2 === 0 ? 'team-a' : 'team-b']));
}

function prepareValidDeal(cards: readonly Card[], playerIds: readonly PlayerId[], options: DealOptions) {
  const random = options.random ?? Math.random;

  for (let attempt = 0; attempt < MAX_DEAL_ATTEMPTS; attempt += 1) {
    const shuffled = shuffleDeck(cards, random);
    const cutIndex = options.cutIndex ?? Math.floor(random() * (shuffled.length + 1));
    const cut = cutDeck(shuffled, cutIndex);
    const deal = dealHands(cut, playerIds);
    const roundTwoPreview = dealHands(deal.deck, playerIds);
    if (
      isRoundDealValid(Object.values(deal.hands)) &&
      isRoundDealValid(Object.values(roundTwoPreview.hands))
    ) return deal;
  }

  throw new Error(`Unable to produce a valid deal after ${MAX_DEAL_ATTEMPTS} attempts.`);
}

export function createInitialGame(options: DealOptions = {}): GameState {
  const mode = options.mode ?? 'classic-1v1';
  const turnOrder = modePlayers(mode);
  const random = options.random ?? Math.random;
  let deck: Card[];
  let floor: Card[] = [];
  let hands: Record<PlayerId, Card[]>;

  if (mode === 'classic-1v1') {
    const deal = prepareValidDeal(createDeck(), turnOrder, options);
    deck = deal.deck;
    hands = deal.hands;
  } else {
    let deal: ReturnType<typeof dealHands> | null = null;
    for (let attempt = 0; attempt < MAX_DEAL_ATTEMPTS; attempt += 1) {
      const shuffled = shuffleDeck(createDeck(), random);
      const cutIndex = options.cutIndex ?? Math.floor(random() * (shuffled.length + 1));
      const cut = cutDeck(shuffled, cutIndex);
      const openingFloor = mode === 'partners-2v2' ? [] : [cut.shift()!];
      const candidate = dealHands(cut, turnOrder, mode === 'partners-2v2' ? 10 : 13);
      if (isRoundDealValid(Object.values(candidate.hands))) {
        deal = candidate;
        floor = openingFloor;
        break;
      }
    }
    if (!deal) throw new Error(`Unable to produce a valid ${mode} deal after ${MAX_DEAL_ATTEMPTS} attempts.`);
    deck = deal.deck;
    hands = deal.hands;
  }
  const startingPlayer = options.startingPlayer ?? turnOrder[Math.floor(random() * turnOrder.length)];

  const players = Object.fromEntries(turnOrder.map((id, index) => [
    id,
    { ...createPlayer(id, `Player ${index + 1}`), hand: hands[id] },
  ]));

  return assertValidGameState({
    mode,
    playerTeams: playerTeams(mode, turnOrder),
    deck,
    floor,
    players,
    builds: [],
    nextBuildSequence: 1,
    nextPendingMoveSequence: 1,
    pendingMove: null,
    turnOrder,
    currentPlayer: startingPlayer,
    round: 1,
    phase: 'round-1',
    lastPlayerToCapture: null,
    lastPlayerToFinishRoundOne: null,
    score: null,
    revision: 0,
  });
}

export function startRoundTwo(state: GameState): GameState {
  if ((state.mode ?? 'classic-1v1') !== 'classic-1v1') {
    throw new Error('Only Classic Duel has a second round.');
  }
  if (state.round !== 1) throw new Error('Round 2 has already started.');
  if (Object.values(state.players).some((player) => player.hand.length > 0)) {
    throw new Error('Round 2 cannot start until both Round 1 hands are empty.');
  }
  if (state.pendingMove) throw new Error('Round 2 cannot start while a move is pending.');
  if (state.builds.length) throw new Error('Round 2 cannot start while a build remains unresolved.');
  if (!state.lastPlayerToFinishRoundOne) throw new Error('Round 1 finisher has not been recorded.');
  if (state.deck.length !== 20) throw new Error('Round 2 requires the unchanged remaining 20-card deck.');

  const starter = state.turnOrder.find((id) => id !== state.lastPlayerToFinishRoundOne)!;
  const dealOrder = [starter, state.lastPlayerToFinishRoundOne];
  const deal = dealHands(state.deck, dealOrder);
  return assertValidGameState({
    ...state,
    deck: deal.deck,
    players: {
      'player-1': { ...state.players['player-1'], hand: deal.hands['player-1'] },
      'player-2': { ...state.players['player-2'], hand: deal.hands['player-2'] },
    },
    currentPlayer: starter,
    round: 2,
    phase: 'round-2',
    revision: state.revision + 1,
  });
}

export function playCardToFloor(state: GameState, playerId: PlayerId, cardId: Card['id']): GameState {
  return applyGameAction(state, { type: 'drop', playerId, cardId });
}

export function canStartNextRound(state: GameState): boolean {
  return (
    (state.mode ?? 'classic-1v1') === 'classic-1v1' &&
    state.round === 1 &&
    Object.values(state.players).every((player) => player.hand.length === 0) &&
    state.builds.length === 0 &&
    state.pendingMove === null &&
    state.deck.length === 20 &&
    state.lastPlayerToFinishRoundOne !== null
  );
}

export function getRoundLabel(round: Round): string {
  return `Round ${round}`;
}
