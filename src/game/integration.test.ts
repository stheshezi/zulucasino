import { describe, expect, it } from 'vitest';
import { BotDifficulty, chooseAutomaticTurn, playAutomaticTurn } from './bot';
import { applyGameAction } from './actions';
import { canStartNextRound, createInitialGame, startRoundTwo } from './game';
import { createPlayerViewState } from './view';
import { validateGameState } from './validation';

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

describe('authoritative 1v1 lifecycle', () => {
  it('lets an opposite-seat partner call Stay and assume build responsibility', () => {
    const state = createInitialGame({ mode: 'partners-2v2', random: seededRandom(19), startingPlayer: 'player-1' });
    const moveCard = (cardId: string, destination: 'player-1' | 'player-3' | 'build') => {
      let card;
      for (const player of Object.values(state.players)) {
        const index = player.hand.findIndex((candidate) => candidate.id === cardId);
        if (index >= 0) card = player.hand.splice(index, 1)[0];
      }
      if (!card) throw new Error(`Fixture card ${cardId} was not found.`);
      if (destination === 'build') return card;
      state.players[destination].hand.push(card);
      return card;
    };
    const buildCards = [moveCard('clubs-5', 'build'), moveCard('diamonds-1', 'build')];
    moveCard('hearts-6', 'player-1');
    moveCard('spades-6', 'player-3');
    moveCard('clubs-6', 'player-3');
    state.builds.push({
      id: 'build-partners', targetValue: 6, ownerPlayerId: 'player-1', ownerTeamId: 'team-a',
      tablePlayerId: 'player-1', secured: true, orderedCards: buildCards, createdInRound: 1,
    });

    state.currentPlayer = 'player-3';
    expect(() => applyGameAction(state, {
      type: 'capture', playerId: 'player-3', playedCardId: 'spades-6',
      groups: [{ type: 'build', buildId: 'build-partners' }],
    })).toThrow('A partner cannot take');

    const assumed = applyGameAction(state, {
      type: 'secure-build', playerId: 'player-3', buildId: 'build-partners', cardId: 'spades-6',
    });
    expect(assumed.builds[0]).toMatchObject({ ownerPlayerId: 'player-3', ownerTeamId: 'team-a', secured: true });
    expect(assumed.builds[0].tablePlayerId).toBe('player-1');
    expect(assumed.players['player-3'].hand.some((card) => card.id === 'clubs-6')).toBe(true);
    assumed.currentPlayer = 'player-1';
    const unrelated = assumed.players['player-1'].hand.find((card) => card.value !== 6)!;
    const afterCreatorDrop = applyGameAction(assumed, {
      type: 'drop', playerId: 'player-1', cardId: unrelated.id,
    });
    expect(afterCreatorDrop.floor.some((card) => card.id === unrelated.id)).toBe(true);

    state.currentPlayer = 'player-1';
    const result = applyGameAction(state, {
      type: 'partner-stay', playerId: 'player-1', partnerPlayerId: 'player-3',
      buildId: 'build-partners', cardId: 'hearts-6',
    });

    expect(result.builds[0]).toMatchObject({ ownerPlayerId: 'player-3', ownerTeamId: 'team-a', secured: true });
    expect(result.builds[0].orderedCards.at(-1)?.id).toBe('hearts-6');
    expect(result.players['player-3'].hand.some((card) => card.id === 'spades-6')).toBe(true);
    expect(result.currentPlayer).toBe('player-2');
    expect(validateGameState(result).valid).toBe(true);
  });

  it.each([
    ['three-hand-rush', 7],
    ['three-hand-qualifier', 7],
    ['partners-2v2', 11],
  ] as const)('plays %s through one complete 40-card deal', (mode, totalPoints) => {
    let state = createInitialGame({ mode, random: seededRandom(73), cutIndex: 5, startingPlayer: 'player-1' });
    let turns = 0;
    while (state.phase !== 'complete' && turns < 100) {
      state = playAutomaticTurn(state, state.currentPlayer, 'medium');
      expect(validateGameState(state).valid).toBe(true);
      turns += 1;
    }

    expect(state.phase).toBe('complete');
    expect(state.floor).toHaveLength(0);
    expect(state.builds).toHaveLength(0);
    expect(Object.values(state.players).flatMap((player) => player.captured)).toHaveLength(40);
    expect(state.score?.combinedPoints).toBe(totalPoints);
  });

  it.each(['easy', 'medium', 'hard'] satisfies BotDifficulty[])(
    '%s computer level chooses a legal opening turn',
    (difficulty) => {
      const state = createInitialGame({ random: seededRandom(41), cutIndex: 7, startingPlayer: 'player-2' });
      const decision = chooseAutomaticTurn(state, 'player-2', difficulty);

      expect(decision.strategy.length).toBeGreaterThan(0);
      expect(decision.state.revision).toBeGreaterThan(state.revision);
      expect(validateGameState(decision.state).valid).toBe(true);
    },
  );

  it('keeps private cards hidden from the opponent view', () => {
    const state = createInitialGame({ random: seededRandom(9), cutIndex: 11, startingPlayer: 'player-1' });
    const view = createPlayerViewState(state, 'player-1');
    const serialized = JSON.stringify(view);

    expect(view.ownHand).toEqual(state.players['player-1'].hand);
    expect(view.players['player-2'].handCount).toBe(10);
    expect(view.players['player-1'].capturedCount).toBeNull();
    expect(view.players['player-2'].capturedCount).toBeNull();
    for (const card of state.players['player-2'].hand) expect(serialized).not.toContain(card.id);
    for (const card of state.deck) expect(serialized).not.toContain(card.id);
  });

  it('plays two automatic rounds, deals Round 2 in starter order, and scores all 40 cards', () => {
    let state = createInitialGame({ random: seededRandom(27), cutIndex: 6, startingPlayer: 'player-1' });
    let turns = 0;
    while (!canStartNextRound(state) && turns < 50) {
      state = playAutomaticTurn(state, state.currentPlayer);
      expect(validateGameState(state).valid).toBe(true);
      turns += 1;
    }

    expect(canStartNextRound(state)).toBe(true);
    expect(state.builds).toHaveLength(0);
    const remainingDeck = [...state.deck];
    const starter = state.turnOrder.find((id) => id !== state.lastPlayerToFinishRoundOne)!;
    state = startRoundTwo(state);
    expect(state.currentPlayer).toBe(starter);
    expect(state.players[starter].hand).toEqual(remainingDeck.filter((_, index) => index % 2 === 0));

    while (state.phase !== 'complete' && turns < 100) {
      state = playAutomaticTurn(state, state.currentPlayer);
      expect(validateGameState(state).valid).toBe(true);
      turns += 1;
    }

    expect(state.phase).toBe('complete');
    expect(state.floor).toHaveLength(0);
    expect(state.builds).toHaveLength(0);
    expect(Object.values(state.players).flatMap((player) => player.captured)).toHaveLength(40);
    expect(state.score?.combinedPoints).toBe(11);
  });
});
