import { describe, expect, it } from 'vitest';
import { createDeck, createInitialGame } from '../src/game/index.js';
import { createInitialMatchState, initialLobbyAcceptedPlayerIds } from './match-store.js';
import {
  advanceQualifierState,
  createRematch,
  latestCompletedGame,
  projectGame,
  projectReplay,
  returnToQualifierState,
} from './matches.js';

describe('online game projection', () => {
  it('starts a group lobby with its creator already accepted', () => {
    const participants = [
      { playerId: 'user-host', displayName: 'Host' },
      { playerId: 'user-b', displayName: 'Beta' },
      { playerId: 'user-c', displayName: 'Gamma' },
    ];

    expect(initialLobbyAcceptedPlayerIds(participants, 'user-host')).toEqual(['user-host']);
    expect(() => initialLobbyAcceptedPlayerIds(participants, 'user-outsider'))
      .toThrow('table creator');
  });

  it('creates one seat-stable initial deal for the accepted player pair', () => {
    const participants = [
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-b', displayName: 'Beta' },
    ];
    const first = createInitialMatchState(participants, 'classic-1v1');
    const second = createInitialMatchState([...participants].reverse(), 'classic-1v1');

    expect(first.players['player-1'].name).toBe('Alpha');
    expect(second.players['player-1'].name).toBe('Alpha');
    expect(first.turnOrder).toEqual(['player-1', 'player-2']);
    expect(second.turnOrder).toEqual(['player-1', 'player-2']);
  });

  it('creates a 3-Hand match with stable seats for all accepted participants', () => {
    const participants = [
      { playerId: 'user-c', displayName: 'Gamma' },
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-b', displayName: 'Beta' },
    ];
    const state = createInitialMatchState(participants, 'three-hand-rush');

    expect(state.turnOrder).toEqual(['player-1', 'player-2', 'player-3']);
    expect(state.players['player-1'].name).toBe('Alpha');
    expect(state.players['player-2'].name).toBe('Beta');
    expect(state.players['player-3'].name).toBe('Gamma');
  });

  it('creates a four-player Partners table with four stable seats', () => {
    const state = createInitialMatchState([
      { playerId: 'user-d', displayName: 'Delta' },
      { playerId: 'user-b', displayName: 'Beta' },
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-c', displayName: 'Gamma' },
    ], 'partners-2v2');

    expect(state.turnOrder).toEqual(['player-1', 'player-2', 'player-3', 'player-4']);
    expect(state.players['player-1'].name).toBe('Alpha');
    expect(state.players['player-4'].name).toBe('Delta');
    expect(state.playerTeams).toEqual({
      'player-1': 'team-a', 'player-2': 'team-b', 'player-3': 'team-a', 'player-4': 'team-b',
    });
  });

  it('projects a Partners table from seat four with only that player hand visible', () => {
    const state = createInitialMatchState([
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-b', displayName: 'Beta' },
      { playerId: 'user-c', displayName: 'Gamma' },
      { playerId: 'user-d', displayName: 'Delta' },
    ], 'partners-2v2');

    const projection = projectGame(state, 3).game;

    expect(projection.players['player-1'].name).toBe('Delta');
    expect(projection.players['player-1'].hand).toEqual(state.players['player-4'].hand);
    expect(projection.turnOrder).toEqual(['player-2', 'player-3', 'player-4', 'player-1']);
    expect(projection.players['player-2'].hand[0].id).toBe('clubs-1');
  });

  it('projects a 3-Hand table from seat three without exposing either opponent hand', () => {
    const state = createInitialMatchState([
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-b', displayName: 'Beta' },
      { playerId: 'user-c', displayName: 'Gamma' },
    ], 'three-hand-rush');

    const projection = projectGame(state, 2).game;

    expect(projection.players['player-1'].name).toBe('Gamma');
    expect(projection.players['player-1'].hand).toEqual(state.players['player-3'].hand);
    expect(projection.players['player-2'].hand[0]).toEqual({ id: 'clubs-1', suit: 'clubs', value: 1 });
    expect(projection.players['player-3'].hand).toHaveLength(state.players['player-2'].hand.length);
  });

  it('keeps the viewer hand while masking the opponent hand and deck', () => {
    const state = createInitialGame({ random: () => 0.37 });
    const projection = projectGame(state, false);

    expect(projection.game.players['player-1'].hand).toEqual(state.players['player-1'].hand);
    expect(projection.game.players['player-2'].hand).toHaveLength(state.players['player-2'].hand.length);
    expect(projection.game.players['player-2'].hand[0]).toEqual({
      id: 'clubs-1',
      suit: 'clubs',
      value: 1,
    });
    expect(projection.game.deck[0]).toEqual({ id: 'clubs-1', suit: 'clubs', value: 1 });
    expect(projection.integrityValid).toBe(true);
  });

  it('swaps seats for the second player and preserves the public exposed top', () => {
    const state = createInitialGame({ random: () => 0.61 });
    const captured = createDeck().slice(10, 12);
    state.players['player-1'].captured = captured;
    const projection = projectGame(state, true);

    expect(projection.game.players['player-1'].hand).toEqual(state.players['player-2'].hand);
    expect(projection.game.players['player-2'].captured).toHaveLength(2);
    expect(projection.game.players['player-2'].captured.at(-1)).toEqual(captured[1]);
    expect(projection.game.players['player-2'].captured[0]).not.toEqual(captured[0]);
  });

  it('reveals captured inventory when the game is complete', () => {
    const state = createInitialGame({ random: () => 0.83 });
    state.phase = 'complete';
    state.players['player-2'].captured = createDeck().slice(0, 3);

    expect(projectGame(state, false).game.players['player-2'].captured)
      .toEqual(state.players['player-2'].captured);
  });

  it('starts a fresh rematch with the same seats and a newer revision', () => {
    const state = createInitialGame({ random: () => 0.41 });
    state.players['player-1'].name = 'Alpha';
    state.players['player-2'].name = 'Beta';
    state.phase = 'complete';
    state.revision = 68;

    const rematch = createRematch(state);

    expect(rematch.phase).toBe('round-1');
    expect(rematch.players['player-1'].name).toBe('Alpha');
    expect(rematch.players['player-2'].name).toBe('Beta');
    expect(rematch.revision).toBe(69);
    expect(rematch).not.toBe(state);
  });

  it('selects only the latest completed game after a rematch has started', () => {
    const firstGame = createInitialGame({ random: () => 0.21 });
    const firstComplete = { ...firstGame, phase: 'complete' as const, revision: 5 };
    const rematch = createRematch(firstComplete);
    const rematchTurn = { ...rematch, revision: rematch.revision + 1 };
    const secondComplete = { ...rematchTurn, phase: 'complete' as const, revision: rematchTurn.revision + 1 };

    expect(latestCompletedGame([firstGame, firstComplete, rematch, rematchTurn, secondComplete]))
      .toEqual([rematch, rematchTurn, secondComplete]);
    expect(latestCompletedGame([firstGame, firstComplete, rematch, rematchTurn]))
      .toEqual([firstGame, firstComplete]);
    expect(latestCompletedGame([firstGame, rematchTurn])).toEqual([]);
  });

  it('reveals both players cards only in the post-game replay projection', () => {
    const state = createInitialGame({ random: () => 0.67 });
    const projection = projectReplay(state, true);

    expect(projection.players['player-1'].hand).toEqual(state.players['player-2'].hand);
    expect(projection.players['player-2'].hand).toEqual(state.players['player-1'].hand);
    expect(projection.deck).toEqual(state.deck);
  });

  it('advances a completed qualifier to the top two and returns the third player as spectator', () => {
    const state = createInitialMatchState([
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-b', displayName: 'Beta' },
      { playerId: 'user-c', displayName: 'Gamma' },
    ], 'three-hand-qualifier');
    state.phase = 'complete';
    state.revision = 12;
    state.score = {
      players: {
        'player-1': { aces: 0, tenOfDiamonds: 0, twoOfSpades: 0, spades: 0, cards: 0, total: 8 },
        'player-2': { aces: 0, tenOfDiamonds: 0, twoOfSpades: 0, spades: 0, cards: 0, total: 24 },
        'player-3': { aces: 0, tenOfDiamonds: 0, twoOfSpades: 0, spades: 0, cards: 0, total: 12 },
      },
      winnerPlayerId: 'player-2',
      combinedPoints: 44,
    };

    const result = advanceQualifierState(state, ['user-a', 'user-b', 'user-c']);

    expect(result.game.mode).toBe('classic-1v1');
    expect(result.game.players['player-1'].name).toBe('Beta');
    expect(result.game.players['player-2'].name).toBe('Gamma');
    expect(result.game.currentPlayer).toBe('player-2');
    expect(result.seatPlayerIds).toEqual(['user-b', 'user-c']);
    expect(result.game.revision).toBe(13);
  });

  it('returns every player to 3-Hand after the online qualifier playoff', () => {
    const qualifier = createInitialMatchState([
      { playerId: 'user-a', displayName: 'Alpha' },
      { playerId: 'user-b', displayName: 'Beta' },
      { playerId: 'user-c', displayName: 'Gamma' },
    ], 'three-hand-qualifier');
    const playoff = createInitialGame({ mode: 'classic-1v1' });
    playoff.phase = 'complete';
    playoff.revision = 8;

    const next = returnToQualifierState(playoff, qualifier, ['user-a', 'user-b', 'user-c']);

    expect(next.mode).toBe('three-hand-qualifier');
    expect(next.turnOrder).toHaveLength(3);
    expect(next.players['player-3'].name).toBe('Gamma');
    expect(next.revision).toBe(9);
  });
});
