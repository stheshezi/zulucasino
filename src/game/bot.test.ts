import { describe, expect, it } from 'vitest';
import { chooseAutomaticTurn } from './bot';
import { createInitialGame } from './game';
import { CardId, GameState, PlayerId } from './types';
import { validateGameState } from './validation';

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function moveCard(state: GameState, cardId: CardId, playerId?: PlayerId) {
  let card;
  for (const player of Object.values(state.players)) {
    const index = player.hand.findIndex((candidate) => candidate.id === cardId);
    if (index >= 0) card = player.hand.splice(index, 1)[0];
  }
  if (!card) throw new Error(`Fixture card ${cardId} was not found.`);
  if (playerId) state.players[playerId].hand.push(card);
  else state.floor.push(card);
}

describe('computer strategy', () => {
  it('creates a legal build instead of blindly dropping in Partners', () => {
    const state = createInitialGame({ mode: 'partners-2v2', random: seededRandom(37), startingPlayer: 'player-2' });
    moveCard(state, 'clubs-2', 'player-2');
    moveCard(state, 'diamonds-9', 'player-2');
    moveCard(state, 'hearts-7');

    const decision = chooseAutomaticTurn(state, 'player-2', 'medium');

    expect(decision.strategy).toMatch(/Build/);
    expect(decision.state.builds[0]).toMatchObject({ ownerPlayerId: 'player-2' });
    expect(decision.state.builds[0].orderedCards).toHaveLength(2);
    expect(decision.state.players['player-2'].hand.some(
      (card) => card.value === decision.state.builds[0].targetValue,
    )).toBe(true);
    expect(validateGameState(decision.state).valid).toBe(true);
  });
});
