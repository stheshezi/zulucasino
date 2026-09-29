import { describe, expect, it } from 'vitest';
import {
  applyGameAction,
  beginMove,
  commitPendingMove,
  getRequiredExposedGroup,
  resolvePendingPublicGroup,
  validateGameAction,
} from './actions';
import { createDeck } from './deck';
import { Build, Card, CardId, CardValue, GameAction, GameState, PlayerId, Round } from './types';
import { validateGameState } from './validation';

interface BuildFixture {
  id: string;
  targetValue: CardValue;
  ownerPlayerId: PlayerId;
  secured: boolean;
  cards: CardId[];
  createdInRound?: Round;
}

interface StateFixture {
  playerOneHand?: CardId[];
  playerTwoHand?: CardId[];
  floor?: CardId[];
  playerOneCaptured?: CardId[];
  playerTwoCaptured?: CardId[];
  builds?: BuildFixture[];
  round?: Round;
  currentPlayer?: PlayerId;
}

function makeState(fixture: StateFixture): GameState {
  const cards = new Map(createDeck().map((card) => [card.id, card]));
  const used = new Set<CardId>();
  const take = (ids: CardId[]): Card[] => ids.map((id) => {
    if (used.has(id)) throw new Error(`Duplicate fixture card: ${id}`);
    const card = cards.get(id);
    if (!card) throw new Error(`Unknown fixture card: ${id}`);
    used.add(id);
    return card;
  });
  const playerOneCaptured = take(fixture.playerOneCaptured ?? []);
  const playerTwoCaptured = take(fixture.playerTwoCaptured ?? []);
  const builds: Build[] = (fixture.builds ?? []).map((build) => ({
    id: build.id,
    targetValue: build.targetValue,
    ownerPlayerId: build.ownerPlayerId,
    secured: build.secured,
    orderedCards: take(build.cards),
    createdInRound: build.createdInRound ?? fixture.round ?? 1,
  }));

  const state: GameState = {
    deck: [...cards.values()].filter((card) => !used.has(card.id)),
    floor: take(fixture.floor ?? []),
    players: {
      'player-1': {
        id: 'player-1',
        name: 'Player 1',
        hand: take(fixture.playerOneHand ?? []),
        captured: playerOneCaptured,
        exposedCapturedCardId: playerOneCaptured.at(-1)?.id ?? null,
      },
      'player-2': {
        id: 'player-2',
        name: 'Player 2',
        hand: take(fixture.playerTwoHand ?? []),
        captured: playerTwoCaptured,
        exposedCapturedCardId: playerTwoCaptured.at(-1)?.id ?? null,
      },
    },
    builds,
    nextBuildSequence: 10,
    nextPendingMoveSequence: 1,
    pendingMove: null,
    turnOrder: ['player-1', 'player-2'],
    currentPlayer: fixture.currentPlayer ?? 'player-1',
    round: fixture.round ?? 1,
    phase: (fixture.round ?? 1) === 1 ? 'round-1' : 'round-2',
    lastPlayerToCapture: null,
    lastPlayerToFinishRoundOne: null,
    score: null,
    revision: 0,
  };

  // Hands and floor are taken after the initial deck snapshot.
  state.deck = [...cards.values()].filter((card) => {
    const located = new Set([
      ...state.floor,
      ...Object.values(state.players).flatMap((player) => [...player.hand, ...player.captured]),
      ...state.builds.flatMap((build) => build.orderedCards),
    ].map((locatedCard) => locatedCard.id));
    return !located.has(card.id);
  });
  expect(validateGameState(state).valid).toBe(true);
  return state;
}

function expectIllegal(state: GameState, action: GameAction, message: string) {
  const result = validateGameAction(state, action);
  expect(result.valid).toBe(false);
  expect(result.errors[0]).toContain(message);
}

function expectIntegrity(state: GameState) {
  expect(validateGameState(state)).toEqual({ valid: true, errors: [] });
}

describe('build legality', () => {
  it('cannot build without retaining a matching target card', () => {
    const state = makeState({ playerOneHand: ['hearts-1'], floor: ['clubs-5'] });
    expectIllegal(state, {
      type: 'create-build', playerId: 'player-1', playedCardId: 'hearts-1',
      floorCardIds: ['clubs-5'], targetValue: 6,
    }, 'retain a matching target card');
  });

  it('cannot create a second build at a target value already on the table', () => {
    const state = makeState({
      playerOneHand: ['clubs-1', 'diamonds-6'],
      floor: ['hearts-5'],
      builds: [{
        id: 'build-1', targetValue: 6, ownerPlayerId: 'player-2', secured: false,
        cards: ['clubs-4', 'diamonds-2'],
      }],
    });

    expectIllegal(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'clubs-1',
      floorCardIds: ['hearts-5'],
      targetValue: 6,
    }, 'A build for 6 already exists');
  });

  it('cannot Stay at a target value already built by the opponent', () => {
    const state = makeState({
      playerOneHand: ['hearts-7', 'spades-7'],
      floor: ['clubs-3', 'diamonds-4'],
      builds: [{
        id: 'build-1', targetValue: 7, ownerPlayerId: 'player-2', secured: false,
        cards: ['hearts-5', 'diamonds-2'],
      }],
    });

    expectIllegal(state, {
      type: 'stay-build',
      playerId: 'player-1',
      playedCardId: 'hearts-7',
      floorCardIds: ['clubs-3', 'diamonds-4'],
    }, 'A build for 7 already exists');
  });

  it('cannot manipulate a build into a target value already used by another build', () => {
    const state = makeState({
      playerOneHand: ['spades-1', 'diamonds-7'],
      builds: [
        { id: 'build-1', targetValue: 6, ownerPlayerId: 'player-2', secured: false, cards: ['clubs-5', 'diamonds-1'] },
        { id: 'build-2', targetValue: 7, ownerPlayerId: 'player-1', secured: false, cards: ['hearts-5', 'clubs-2'] },
      ],
    });

    expectIllegal(state, {
      type: 'manipulate-build',
      playerId: 'player-1',
      buildId: 'build-1',
      cards: [{ source: 'hand', cardId: 'spades-1' }],
      newTargetValue: 7,
    }, 'A build for 7 already exists');
  });

  it('stores a build group from larger bottom card to smaller top card', () => {
    const state = makeState({
      playerOneHand: ['spades-9', 'diamonds-10'],
      floor: ['clubs-1'],
    });
    const result = applyGameAction(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'spades-9',
      floorCardIds: ['clubs-1'],
      targetValue: 10,
    });

    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual(['spades-9', 'clubs-1']);
    expectIntegrity(result);
  });

  it('creates one secured build when a complete loose target group is also selected', () => {
    const state = makeState({
      playerOneHand: ['hearts-1', 'diamonds-10'],
      floor: ['clubs-9', 'spades-10'],
    });
    const result = applyGameAction(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'hearts-1',
      floorCardIds: ['clubs-9'],
      additionalFloorGroups: [['spades-10']],
      targetValue: 10,
    });

    expect(result.builds).toHaveLength(1);
    expect(result.builds[0]).toMatchObject({ targetValue: 10, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'clubs-9', 'hearts-1', 'spades-10',
    ]);
    expectIntegrity(result);
  });

  it('uses a loose target card to anchor an exposed card in a new secured build', () => {
    const state = makeState({
      playerOneHand: ['spades-9', 'diamonds-10'],
      floor: ['clubs-10'],
      playerTwoCaptured: ['hearts-1'],
    });
    const result = applyGameAction(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'spades-9',
      floorCardIds: [],
      publicCards: [{ source: 'exposed', playerId: 'player-2', cardId: 'hearts-1' }],
      additionalPublicGroups: [[{ source: 'floor', cardId: 'clubs-10' }]],
      targetValue: 10,
    });

    expect(result.builds[0]).toMatchObject({ targetValue: 10, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'clubs-10', 'spades-9', 'hearts-1',
    ]);
    expect(result.players['player-2'].captured).toEqual([]);
    expectIntegrity(result);
  });

  it('implicitly anchors an exposed hand group with a matching loose target card', () => {
    const state = makeState({
      playerOneHand: ['clubs-2', 'diamonds-9'],
      floor: ['hearts-3', 'spades-9'],
      playerTwoCaptured: ['clubs-6', 'spades-4'],
    });
    const result = applyGameAction(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'clubs-2',
      floorCardIds: ['hearts-3'],
      publicCards: [
        { source: 'exposed', playerId: 'player-2', cardId: 'spades-4' },
        { source: 'floor', cardId: 'hearts-3' },
      ],
      targetValue: 9,
    });

    expect(result.floor).toEqual([]);
    expect(result.builds[0]).toMatchObject({ targetValue: 9, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'spades-9', 'spades-4', 'hearts-3', 'clubs-2',
    ]);
    expect(result.players['player-1'].hand.map((card) => card.id)).toEqual(['diamonds-9']);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('clubs-6');
    expectIntegrity(result);
  });

  it('adds consecutive matching exposed tops after the hand group creates the build', () => {
    const state = makeState({
      playerOneHand: ['clubs-7', 'diamonds-9'],
      floor: ['hearts-2'],
      playerTwoCaptured: ['diamonds-4', 'hearts-9', 'spades-9'],
    });
    const result = applyGameAction(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'clubs-7',
      floorCardIds: ['hearts-2'],
      targetValue: 9,
    });

    expect(result.builds[0]).toMatchObject({ targetValue: 9, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'clubs-7', 'hearts-2', 'spades-9', 'hearts-9',
    ]);
    expect(result.players['player-2'].captured.map((card) => card.id)).toEqual(['diamonds-4']);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('diamonds-4');
    expectIntegrity(result);
  });

  it('automatically adds a loose target card when creating its matching build', () => {
    const state = makeState({
      playerOneHand: ['clubs-7', 'diamonds-9'],
      floor: ['hearts-2', 'spades-9'],
    });
    const result = applyGameAction(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'clubs-7',
      floorCardIds: ['hearts-2'],
      targetValue: 9,
    });

    expect(result.floor).toEqual([]);
    expect(result.builds[0]).toMatchObject({ targetValue: 9, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'clubs-7', 'hearts-2', 'spades-9',
    ]);
    expectIntegrity(result);
  });

  it('rejects an exposed card in a new build without a loose target anchor', () => {
    const state = makeState({
      playerOneHand: ['spades-9', 'diamonds-10'],
      playerTwoCaptured: ['hearts-1'],
    });
    expectIllegal(state, {
      type: 'create-build',
      playerId: 'player-1',
      playedCardId: 'spades-9',
      floorCardIds: [],
      publicCards: [{ source: 'exposed', playerId: 'player-2', cardId: 'hearts-1' }],
      targetValue: 10,
    }, 'loose target card');
  });

  it('allows an unsecured build to be manipulated upward and preserves order', () => {
    const state = makeState({
      playerOneHand: ['spades-1', 'diamonds-7'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-2', secured: false, cards: ['clubs-5', 'diamonds-1'] }],
    });
    const result = applyGameAction(state, {
      type: 'manipulate-build', playerId: 'player-1', buildId: 'build-1',
      cards: [{ source: 'hand', cardId: 'spades-1' }], newTargetValue: 7,
    });
    expect(result.builds[0]).toMatchObject({
      targetValue: 7,
      ownerPlayerId: 'player-1',
      tablePlayerId: 'player-1',
      secured: false,
    });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual(['clubs-5', 'diamonds-1', 'spades-1']);
    expectIntegrity(result);
  });

  it('does not allow a secured build to be manipulated', () => {
    const state = makeState({
      playerOneHand: ['spades-1', 'diamonds-7'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-2', secured: true, cards: ['clubs-5', 'diamonds-1'] }],
    });
    expectIllegal(state, {
      type: 'manipulate-build', playerId: 'player-1', buildId: 'build-1',
      cards: [{ source: 'hand', cardId: 'spades-1' }], newTargetValue: 7,
    }, 'secured build');
  });

  it('does not allow a 10-build to be manipulated upward', () => {
    const state = makeState({
      playerOneHand: ['spades-1'],
      builds: [{ id: 'build-1', targetValue: 10, ownerPlayerId: 'player-2', secured: false, cards: ['clubs-9', 'diamonds-1'] }],
    });
    expectIllegal(state, {
      type: 'manipulate-build', playerId: 'player-1', buildId: 'build-1',
      cards: [{ source: 'hand', cardId: 'spades-1' }], newTargetValue: 10,
    }, '10-build');
  });

  it('does not call a build secured merely because it was raised to 10', () => {
    const state = makeState({
      playerOneHand: ['spades-1', 'diamonds-10'],
      builds: [{
        id: 'build-1',
        targetValue: 9,
        ownerPlayerId: 'player-2',
        secured: false,
        cards: ['clubs-8', 'diamonds-1'],
      }],
    });

    const result = applyGameAction(state, {
      type: 'manipulate-build',
      playerId: 'player-1',
      buildId: 'build-1',
      cards: [{ source: 'hand', cardId: 'spades-1' }],
      newTargetValue: 10,
    });

    expect(result.builds[0]).toMatchObject({
      targetValue: 10,
      ownerPlayerId: 'player-1',
      secured: false,
    });
    expectIntegrity(result);
  });

  it('requires another matching card to remain after Stay', () => {
    const state = makeState({ playerOneHand: ['hearts-9'], floor: ['clubs-9'] });
    expectIllegal(state, {
      type: 'stay-build', playerId: 'player-1', playedCardId: 'hearts-9', floorCardIds: ['clubs-9'],
    }, 'another matching target card');
  });

  it('allows a selected loose group to Stay at its matching target', () => {
    const state = makeState({
      playerOneHand: ['hearts-7', 'spades-7'],
      floor: ['clubs-3', 'diamonds-4'],
    });
    const result = applyGameAction(state, {
      type: 'stay-build',
      playerId: 'player-1',
      playedCardId: 'hearts-7',
      floorCardIds: ['clubs-3', 'diamonds-4'],
    });

    expect(result.builds[0]).toMatchObject({ targetValue: 7, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'diamonds-4', 'clubs-3', 'hearts-7',
    ]);
    expect(result.players['player-1'].hand.map((card) => card.id)).toEqual(['spades-7']);
    expectIntegrity(result);
  });

  it('requires an active-player hand card to continue a build', () => {
    const state = makeState({
      floor: ['hearts-6'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: false, cards: ['clubs-5', 'diamonds-1'] }],
    });
    expectIllegal(state, {
      type: 'continue-build', playerId: 'player-1', buildId: 'build-1',
      cards: [{ source: 'floor', cardId: 'hearts-6' }],
    }, 'hand card');
  });

  it('continues an owned build with a hand card and opponent exposed top card', () => {
    const state = makeState({
      playerOneHand: ['hearts-1', 'clubs-6'],
      playerTwoCaptured: ['clubs-2', 'spades-5'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: false, cards: ['clubs-4', 'diamonds-2'] }],
    });
    const result = applyGameAction(state, {
      type: 'continue-build', playerId: 'player-1', buildId: 'build-1',
      cards: [
        { source: 'hand', cardId: 'hearts-1' },
        { source: 'exposed', playerId: 'player-2', cardId: 'spades-5' },
      ],
    });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'clubs-4', 'diamonds-2', 'spades-5', 'hearts-1',
    ]);
    expect(result.builds[0].secured).toBe(true);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('clubs-2');
    expectIntegrity(result);
  });

  it('continues an owned build with exposed plus loose plus hand cards', () => {
    const state = makeState({
      playerOneHand: ['clubs-6', 'spades-10'],
      playerTwoCaptured: ['hearts-4', 'diamonds-1'],
      floor: ['hearts-3'],
      builds: [{
        id: 'build-10',
        targetValue: 10,
        ownerPlayerId: 'player-1',
        secured: true,
        cards: ['clubs-7', 'diamonds-3'],
      }],
    });
    const result = applyGameAction(state, {
      type: 'continue-build',
      playerId: 'player-1',
      buildId: 'build-10',
      cards: [
        { source: 'hand', cardId: 'clubs-6' },
        { source: 'floor', cardId: 'hearts-3' },
        { source: 'exposed', playerId: 'player-2', cardId: 'diamonds-1' },
      ],
    });

    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'clubs-7', 'diamonds-3', 'clubs-6', 'hearts-3', 'diamonds-1',
    ]);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('hearts-4');
    expect(result.players['player-1'].hand.map((card) => card.id)).toEqual(['spades-10']);
    expectIntegrity(result);
  });

  it('continues one build with an exposed target group and a hand-plus-loose group', () => {
    const state = makeState({
      playerOneHand: ['hearts-7', 'diamonds-10'],
      playerTwoCaptured: ['spades-5', 'clubs-10'],
      floor: ['clubs-3'],
      builds: [{
        id: 'build-10',
        targetValue: 10,
        ownerPlayerId: 'player-1',
        secured: false,
        cards: ['spades-6', 'diamonds-4'],
      }],
    });

    const result = applyGameAction(state, {
      type: 'continue-build',
      playerId: 'player-1',
      buildId: 'build-10',
      cards: [
        { source: 'hand', cardId: 'hearts-7' },
        { source: 'floor', cardId: 'clubs-3' },
      ],
      additionalPublicGroups: [[
        { source: 'exposed', playerId: 'player-2', cardId: 'clubs-10' },
      ]],
    });

    expect(result.builds[0]).toMatchObject({ targetValue: 10, secured: true });
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'spades-6', 'diamonds-4', 'hearts-7', 'clubs-3', 'clubs-10',
    ]);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('spades-5');
    expect(result.players['player-1'].hand.map((card) => card.id)).toEqual(['diamonds-10']);
    expectIntegrity(result);
  });

  it('stays on an owned build and adds the matching exposed top before the hand card', () => {
    const state = makeState({
      playerOneHand: ['hearts-10', 'diamonds-10'],
      playerTwoCaptured: ['spades-5', 'clubs-10'],
      builds: [{
        id: 'build-10',
        targetValue: 10,
        ownerPlayerId: 'player-1',
        secured: true,
        cards: ['spades-6', 'clubs-4'],
      }],
    });

    const result = applyGameAction(state, {
      type: 'secure-build',
      playerId: 'player-1',
      buildId: 'build-10',
      cardId: 'hearts-10',
    });

    expect(result.builds[0].secured).toBe(true);
    expect(result.builds[0].orderedCards.map((card) => card.id)).toEqual([
      'spades-6', 'clubs-4', 'clubs-10', 'hearts-10',
    ]);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('spades-5');
    expect(result.players['player-1'].hand.map((card) => card.id)).toEqual(['diamonds-10']);
    expectIntegrity(result);
  });
});

describe('round restrictions', () => {
  const ownedBuild: BuildFixture = {
    id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: false,
    cards: ['clubs-5', 'diamonds-1'],
  };

  it('blocks an arbitrary Round 1 drop while owning a build', () => {
    const state = makeState({ playerOneHand: ['hearts-2'], builds: [ownedBuild], round: 1 });
    expectIllegal(state, { type: 'drop', playerId: 'player-1', cardId: 'hearts-2' }, 'Round 1');
  });

  it('allows a tactical Round 2 drop while retaining build ownership', () => {
    const state = makeState({ playerOneHand: ['hearts-2', 'clubs-3'], builds: [ownedBuild], round: 2 });
    const result = applyGameAction(state, { type: 'drop', playerId: 'player-1', cardId: 'hearts-2' });
    expect(result.floor.map((card) => card.id)).toContain('hearts-2');
    expect(result.builds[0].ownerPlayerId).toBe('player-1');
    expectIntegrity(result);
  });
});

describe('capture legality', () => {
  it('automatically takes a matching exposed top 7 during a selected 3 plus 4 capture', () => {
    const state = makeState({
      playerOneHand: ['hearts-7', 'clubs-2'],
      floor: ['clubs-3', 'diamonds-4'],
      playerTwoCaptured: ['spades-5', 'spades-7'],
    });
    const result = applyGameAction(state, {
      type: 'capture',
      playerId: 'player-1',
      playedCardId: 'hearts-7',
      groups: [{
        type: 'cards',
        cards: [
          { source: 'floor', cardId: 'clubs-3' },
          { source: 'floor', cardId: 'diamonds-4' },
        ],
      }],
    });
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'diamonds-4', 'clubs-3', 'spades-7', 'hearts-7',
    ]);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('spades-5');
    expectIntegrity(result);
  });

  it('locks unrelated actions and repeatedly reveals applicable top cards before take-home', () => {
    let state = makeState({
      playerOneHand: ['hearts-6', 'clubs-8'],
      floor: ['spades-1', 'hearts-2'],
      playerTwoCaptured: ['clubs-4', 'diamonds-5'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: true, cards: ['clubs-3', 'diamonds-3'] }],
    });
    state = beginMove(state, {
      playerId: 'player-1', mode: 'capture', reservedHandCardId: 'hearts-6',
      targetValue: 6, selectedBuildId: 'build-1',
    });
    expectIllegal(state, { type: 'drop', playerId: 'player-1', cardId: 'clubs-8' }, 'pending move');

    const first = getRequiredExposedGroup(state)!;
    expect(first.map((ref) => ref.cardId)).toEqual(['diamonds-5', 'spades-1']);
    state = resolvePendingPublicGroup(state, 'player-1', first, 'extra-capture');
    expect(state.players['player-2'].exposedCapturedCardId).toBe('clubs-4');

    const second = getRequiredExposedGroup(state)!;
    expect(second.map((ref) => ref.cardId)).toEqual(['clubs-4', 'hearts-2']);
    state = resolvePendingPublicGroup(state, 'player-1', second, 'extra-capture');
    expect(getRequiredExposedGroup(state)).toBeNull();
    state = commitPendingMove(state, 'player-1');

    expect(state.players['player-1'].captured.map((card) => card.id)).toEqual([
      'diamonds-5', 'spades-1', 'clubs-4', 'hearts-2', 'clubs-3', 'diamonds-3', 'hearts-6',
    ]);
    expectIntegrity(state);
  });

  it('captures only the explicitly selected legal set', () => {
    const state = makeState({
      playerOneHand: ['hearts-6'],
      floor: ['clubs-4', 'diamonds-2', 'spades-6'],
    });
    const result = applyGameAction(state, {
      type: 'capture', playerId: 'player-1', playedCardId: 'hearts-6',
      groups: [{ type: 'cards', cards: [
        { source: 'floor', cardId: 'clubs-4' },
        { source: 'floor', cardId: 'diamonds-2' },
      ] }],
    });
    expect(result.floor.map((card) => card.id)).toEqual(['spades-6']);
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'clubs-4', 'diamonds-2', 'hearts-6',
    ]);
    expect(result.players['player-1'].exposedCapturedCardId).toBe('hearts-6');
    expect(result.lastPlayerToCapture).toBe('player-1');
    expectIntegrity(result);
  });

  it('does not allow an exposed card to start a Take without an existing floor game', () => {
    let state = makeState({
      playerOneHand: ['hearts-5'],
      playerTwoHand: ['diamonds-5'],
      playerOneCaptured: ['clubs-1'],
      floor: ['spades-4', 'diamonds-1'],
    });

    state = applyGameAction(state, {
      type: 'capture',
      playerId: 'player-1',
      playedCardId: 'hearts-5',
      groups: [{ type: 'cards', cards: [
        { source: 'floor', cardId: 'spades-4' },
        { source: 'floor', cardId: 'diamonds-1' },
      ] }],
    });
    expect(state.players['player-1'].exposedCapturedCardId).toBe('hearts-5');

    expectIllegal(state, {
      type: 'capture',
      playerId: 'player-2',
      playedCardId: 'diamonds-5',
      groups: [{ type: 'cards', cards: [
        { source: 'exposed', playerId: 'player-1', cardId: 'hearts-5' },
      ] }],
    }, 'cannot start a Take');
    expect(state.players['player-1'].exposedCapturedCardId).toBe('hearts-5');
    expectIntegrity(state);
  });

  it('takes a loose target and an exposed-plus-loose target group together', () => {
    const state = makeState({
      playerOneHand: ['hearts-9', 'clubs-3'],
      playerTwoCaptured: ['clubs-6', 'spades-2'],
      floor: ['clubs-9', 'diamonds-7', 'hearts-4'],
    });
    const result = applyGameAction(state, {
      type: 'capture',
      playerId: 'player-1',
      playedCardId: 'hearts-9',
      groups: [
        { type: 'cards', cards: [{ source: 'floor', cardId: 'clubs-9' }] },
        { type: 'cards', cards: [
          { source: 'exposed', playerId: 'player-2', cardId: 'spades-2' },
          { source: 'floor', cardId: 'diamonds-7' },
        ] },
      ],
    });

    expect(result.floor.map((card) => card.id)).toEqual(['hearts-4']);
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'clubs-9', 'diamonds-7', 'spades-2', 'hearts-9',
    ]);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('clubs-6');
    expectIntegrity(result);
  });

  it('forces own-build capture when the selected target is the last match', () => {
    const state = makeState({
      playerOneHand: ['hearts-6', 'spades-2'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: false, cards: ['clubs-5', 'diamonds-1'] }],
    });
    const result = applyGameAction(state, { type: 'drop', playerId: 'player-1', cardId: 'hearts-6' });
    expect(result.builds).toHaveLength(0);
    expect(result.floor).toHaveLength(0);
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'clubs-5', 'diamonds-1', 'hearts-6',
    ]);
    expect(result.lastPlayerToCapture).toBe('player-1');
    expectIntegrity(result);
  });

  it('allows a secured build to be captured with its matching value', () => {
    const state = makeState({
      playerOneHand: ['hearts-6'],
      builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-2', secured: true, cards: ['clubs-5', 'diamonds-1'] }],
    });
    const result = applyGameAction(state, {
      type: 'capture', playerId: 'player-1', playedCardId: 'hearts-6',
      groups: [{ type: 'build', buildId: 'build-1' }],
    });
    expect(result.builds).toHaveLength(0);
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'clubs-5', 'diamonds-1', 'hearts-6',
    ]);
    expectIntegrity(result);
  });

  it('must take the opponent exposed 10 before taking a 10-build home', () => {
    const state = makeState({
      playerOneHand: ['hearts-10'],
      playerTwoCaptured: ['spades-5', 'clubs-10'],
      builds: [{
        id: 'build-10',
        targetValue: 10,
        ownerPlayerId: 'player-1',
        secured: true,
        cards: ['diamonds-6', 'clubs-4'],
      }],
    });

    const result = applyGameAction(state, {
      type: 'capture',
      playerId: 'player-1',
      playedCardId: 'hearts-10',
      groups: [{ type: 'build', buildId: 'build-10' }],
    });

    expect(result.builds).toHaveLength(0);
    expect(result.players['player-2'].captured.map((card) => card.id)).toEqual(['spades-5']);
    expect(result.players['player-2'].exposedCapturedCardId).toBe('spades-5');
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'clubs-10', 'diamonds-6', 'clubs-4', 'hearts-10',
    ]);
    expect(result.lastPlayerToCapture).toBe('player-1');
    expectIntegrity(result);
  });

  it('automatically takes a loose target card with its matching build', () => {
    const state = makeState({
      playerOneHand: ['hearts-10'],
      floor: ['spades-10', 'hearts-4'],
      builds: [{
        id: 'build-10',
        targetValue: 10,
        ownerPlayerId: 'player-1',
        secured: true,
        cards: ['diamonds-6', 'clubs-4'],
      }],
    });

    const result = applyGameAction(state, {
      type: 'capture',
      playerId: 'player-1',
      playedCardId: 'hearts-10',
      groups: [{ type: 'build', buildId: 'build-10' }],
    });

    expect(result.builds).toEqual([]);
    expect(result.floor.map((card) => card.id)).toEqual(['hearts-4']);
    expect(result.players['player-1'].captured.map((card) => card.id)).toEqual([
      'spades-10', 'diamonds-6', 'clubs-4', 'hearts-10',
    ]);
    expectIntegrity(result);
  });
});

describe('40-card integrity after every action type', () => {
  it('remains valid after create, secure, Stay, continue, manipulate, capture, and drop actions', () => {
    const scenarios: Array<{ state: GameState; action: GameAction }> = [
      {
        state: makeState({ playerOneHand: ['hearts-1', 'spades-6'], floor: ['clubs-5'] }),
        action: { type: 'create-build', playerId: 'player-1', playedCardId: 'hearts-1', floorCardIds: ['clubs-5'], targetValue: 6 },
      },
      {
        state: makeState({ playerOneHand: ['hearts-6', 'spades-6'], builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: false, cards: ['clubs-5', 'diamonds-1'] }] }),
        action: { type: 'secure-build', playerId: 'player-1', buildId: 'build-1', cardId: 'hearts-6' },
      },
      {
        state: makeState({ playerOneHand: ['hearts-9', 'spades-9'], floor: ['clubs-9'] }),
        action: { type: 'stay-build', playerId: 'player-1', playedCardId: 'hearts-9', floorCardIds: ['clubs-9'] },
      },
      {
        state: makeState({ playerOneHand: ['hearts-1', 'clubs-6'], floor: ['spades-5'], builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-1', secured: false, cards: ['clubs-4', 'diamonds-2'] }] }),
        action: { type: 'continue-build', playerId: 'player-1', buildId: 'build-1', cards: [{ source: 'hand', cardId: 'hearts-1' }, { source: 'floor', cardId: 'spades-5' }] },
      },
      {
        state: makeState({ playerOneHand: ['spades-1', 'diamonds-7'], builds: [{ id: 'build-1', targetValue: 6, ownerPlayerId: 'player-2', secured: false, cards: ['clubs-5', 'diamonds-1'] }] }),
        action: { type: 'manipulate-build', playerId: 'player-1', buildId: 'build-1', cards: [{ source: 'hand', cardId: 'spades-1' }], newTargetValue: 7 },
      },
      {
        state: makeState({ playerOneHand: ['hearts-6'], floor: ['clubs-6'] }),
        action: { type: 'capture', playerId: 'player-1', playedCardId: 'hearts-6', groups: [{ type: 'cards', cards: [{ source: 'floor', cardId: 'clubs-6' }] }] },
      },
      {
        state: makeState({ playerOneHand: ['hearts-2'] }),
        action: { type: 'drop', playerId: 'player-1', cardId: 'hearts-2' },
      },
    ];

    for (const scenario of scenarios) expectIntegrity(applyGameAction(scenario.state, scenario.action));
  });
});
