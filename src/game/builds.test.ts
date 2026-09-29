import { describe, expect, it } from 'vitest';
import { getBuildCardGroups, getBuildDisplayGroups, orderBuildGroup } from './builds';
import { createDeck } from './deck';
import { Build } from './types';

const cards = new Map(createDeck().map((card) => [card.id, card]));

function build(cardIds: Build['orderedCards'][number]['id'][]): Build {
  return {
    id: 'build-test',
    targetValue: 10,
    ownerPlayerId: 'player-1',
    secured: cardIds.length > 2,
    orderedCards: cardIds.map((id) => cards.get(id)!),
    createdInRound: 1,
  };
}

describe('build card groups', () => {
  it('detects consecutive target groups in physical bottom-to-top order', () => {
    const subject = build(['spades-9', 'clubs-1', 'hearts-6', 'diamonds-4']);
    expect(getBuildCardGroups(subject).map((group) => group.map((card) => card.value))).toEqual([
      [9, 1],
      [6, 4],
    ]);
    expect(subject.orderedCards.map((card) => card.value)).toEqual([9, 1, 6, 4]);
  });

  it('orders each physical group with the larger card on the bottom', () => {
    expect(orderBuildGroup([cards.get('clubs-1')!, cards.get('spades-9')!]).map((card) => card.value)).toEqual([9, 1]);

    const subject = build(['spades-9', 'clubs-1', 'hearts-6', 'diamonds-4']);
    expect(getBuildDisplayGroups(subject).map((group) => group.map((card) => card.value))).toEqual([
      [9, 1],
      [6, 4],
    ]);
    expect(subject.orderedCards.map((card) => card.value)).toEqual([9, 1, 6, 4]);
  });
});
