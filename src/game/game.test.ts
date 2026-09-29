import { describe, expect, it } from 'vitest';
import { createDeck, cutDeck, shuffleDeck } from './deck';
import { createInitialGame, playCardToFloor, startRoundTwo } from './game';
import { calculateScore } from './scoring';
import { validateGameState } from './validation';

describe('deck', () => {
  it('creates 40 uniquely identified physical cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(40);
    expect(new Set(deck.map((card) => card.id)).size).toBe(40);
  });

  it('shuffles without mutating or losing cards', () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, () => 0.25);
    expect(shuffled).not.toBe(deck);
    expect(shuffled).not.toEqual(deck);
    expect(new Set(shuffled.map((card) => card.id))).toEqual(new Set(deck.map((card) => card.id)));
  });

  it('cuts at the requested position', () => {
    const deck = createDeck();
    const cut = cutDeck(deck, 12);
    expect(cut[0]).toBe(deck[12]);
    expect(cut.at(-1)).toBe(deck[11]);
  });
});

describe('game state', () => {
  it('deals 3-Hand from one deck with thirteen cards each and one loose floor card', () => {
    const state = createInitialGame({ mode: 'three-hand-rush', random: () => 0.42, cutIndex: 7 });
    expect(state.turnOrder).toHaveLength(3);
    expect(state.floor).toHaveLength(1);
    expect(state.deck).toHaveLength(0);
    state.turnOrder.forEach((id) => expect(state.players[id].hand).toHaveLength(13));
    expect(validateGameState(state).valid).toBe(true);
  });

  it('deals Partners ten cards each with opposite seats on the same team and no floor card', () => {
    const state = createInitialGame({ mode: 'partners-2v2', random: () => 0.42, cutIndex: 7 });
    expect(state.turnOrder).toEqual(['player-1', 'player-2', 'player-3', 'player-4']);
    expect(state.floor).toHaveLength(0);
    expect(state.deck).toHaveLength(0);
    state.turnOrder.forEach((id) => expect(state.players[id].hand).toHaveLength(10));
    expect(state.playerTeams).toEqual({
      'player-1': 'team-a', 'player-2': 'team-b', 'player-3': 'team-a', 'player-4': 'team-b',
    });
    expect(validateGameState(state).valid).toBe(true);
  });

  it('removes Pack and spade-majority points from 3-Hand scoring', () => {
    const state = createInitialGame({ mode: 'three-hand-rush', random: () => 0.31 });
    const allCards = [
      ...state.floor,
      ...state.turnOrder.flatMap((id) => state.players[id].hand),
    ];
    state.floor = [];
    state.turnOrder.forEach((id) => { state.players[id].hand = []; state.players[id].captured = []; });
    state.players['player-1'].captured = allCards;
    const score = calculateScore(state);
    expect(score.combinedPoints).toBe(7);
    expect(Object.values(score.players).every((entry) => entry.cards === 0 && entry.spades === 0)).toBe(true);
  });

  it('combines partner inventories for the standard eleven-point team score', () => {
    const state = createInitialGame({ mode: 'partners-2v2', random: () => 0.31 });
    const allCards = state.turnOrder.flatMap((id) => state.players[id].hand);
    state.turnOrder.forEach((id) => { state.players[id].hand = []; state.players[id].captured = []; });
    allCards.forEach((card, index) => state.players[state.turnOrder[index % 4]].captured.push(card));
    const score = calculateScore(state);
    expect(score.combinedPoints).toBe(11);
    expect(Object.keys(score.teams ?? {})).toEqual(['team-a', 'team-b']);
  });

  it('deals ten cards each and keeps all cards in one location', () => {
    const state = createInitialGame({ random: () => 0.42, cutIndex: 7 });
    expect(state.players['player-1'].hand).toHaveLength(10);
    expect(state.players['player-2'].hand).toHaveLength(10);
    expect(state.deck).toHaveLength(20);
    expect(validateGameState(state)).toEqual({ valid: true, errors: [] });
  });

  it('preserves the invariant through a loose-card drop', () => {
    let state = createInitialGame({ random: () => 0.37 });
    const card = state.players['player-1'].hand[0];
    state = playCardToFloor(state, 'player-1', card.id);
    expect(state.floor).toContain(card);
    expect(validateGameState(state).valid).toBe(true);
  });

  it('deals the remaining deck in Round 2', () => {
    const initial = createInitialGame({ random: () => 0.31 });
    const state = {
      ...initial,
      floor: [...initial.floor, ...initial.players['player-1'].hand, ...initial.players['player-2'].hand],
      players: {
        'player-1': { ...initial.players['player-1'], hand: [] },
        'player-2': { ...initial.players['player-2'], hand: [] },
      },
      lastPlayerToFinishRoundOne: 'player-2',
    };
    const roundTwo = startRoundTwo(state);
    expect(roundTwo.round).toBe(2);
    expect(roundTwo.deck).toHaveLength(0);
    expect(roundTwo.players['player-1'].hand).toHaveLength(10);
    expect(roundTwo.players['player-2'].hand).toHaveLength(10);
    expect(roundTwo.currentPlayer).toBe('player-1');
    expect(validateGameState(roundTwo).valid).toBe(true);
  });

  it('reports duplicate card locations', () => {
    const state = createInitialGame({ random: () => 0.22 });
    state.floor.push(state.deck[0]);
    const result = validateGameState(state);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('appears in both'))).toBe(true);
  });
});
