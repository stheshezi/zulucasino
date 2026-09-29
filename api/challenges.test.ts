import { describe, expect, it } from 'vitest';
import { clearMatchingActiveMatch, type PlayerNetwork } from './challenges.js';

function networkWithMatch(): PlayerNetwork {
  return {
    friends: [],
    challenges: [],
    activeMatch: {
      matchId: 'match-finished',
      opponent: {
        playerId: 'user-b',
        displayName: 'Beta',
        username: null,
        imageUrl: '',
      },
      mode: 'classic-1v1',
      createdAt: '2026-09-29T00:00:00.000Z',
      status: 'ready',
    },
  };
}

describe('online table lifecycle', () => {
  it('clears only the matching active table', () => {
    const network = networkWithMatch();

    expect(clearMatchingActiveMatch(network, 'another-match')).toBeNull();
    expect(clearMatchingActiveMatch(network, 'match-finished')).toEqual({
      friends: [],
      challenges: [],
    });
    expect(network.activeMatch?.matchId).toBe('match-finished');
  });
});
