import { describe, expect, it } from 'vitest';
import { applyGameAction, createInitialGame } from './game';
import { describeMoveFeedback } from './moveFeedback';

describe('describeMoveFeedback', () => {
  it('describes an authoritative drop as a placement effect', () => {
    const before = createInitialGame({ random: () => 0.25, startingPlayer: 'player-1' });
    const card = before.players['player-1'].hand[0];
    const after = applyGameAction(before, { type: 'drop', playerId: 'player-1', cardId: card.id });

    expect(describeMoveFeedback(before, after, 'player-1')).toMatchObject({
      actorPlayerId: 'player-1',
      choice: 'drop',
    });
  });

  it('describes an authoritative capture as a take effect', () => {
    const base = createInitialGame({ random: () => 0.25, startingPlayer: 'player-1' });
    const handCard = base.players['player-1'].hand[0];
    const matchingCard = [...base.deck, ...base.players['player-2'].hand].find(
      (card) => card.value === handCard.value,
    );
    if (!matchingCard) throw new Error('Expected another physical card with the same value.');
    const before = structuredClone(base);
    before.deck = before.deck.filter((card) => card.id !== matchingCard.id);
    before.players['player-2'].hand = before.players['player-2'].hand.filter((card) => card.id !== matchingCard.id);
    before.floor.push(matchingCard);
    const after = applyGameAction(before, {
      type: 'capture',
      playerId: 'player-1',
      playedCardId: handCard.id,
      groups: [{ type: 'cards', cards: [{ source: 'floor', cardId: matchingCard.id }] }],
    });

    expect(describeMoveFeedback(before, after, 'player-1')).toMatchObject({
      actorPlayerId: 'player-1',
      choice: 'take',
      floorCardIds: [matchingCard.id],
    });
  });
});
