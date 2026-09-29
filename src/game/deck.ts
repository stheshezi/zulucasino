import { Card, CardValue, SUITS } from './types';

export const DECK_SIZE = 40;

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) =>
    Array.from({ length: 10 }, (_, index) => {
      const value = (index + 1) as CardValue;
      return { id: `${suit}-${value}`, suit, value } as Card;
    }),
  );
}

export function shuffleDeck(cards: readonly Card[], random = Math.random): Card[] {
  const shuffled = [...cards];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

export function cutDeck(cards: readonly Card[], cutIndex: number): Card[] {
  if (!Number.isInteger(cutIndex) || cutIndex < 0 || cutIndex > cards.length) {
    throw new RangeError(`Cut index must be an integer from 0 to ${cards.length}.`);
  }

  return [...cards.slice(cutIndex), ...cards.slice(0, cutIndex)];
}
