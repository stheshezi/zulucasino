import { describe, expect, it } from 'vitest';
import { createDeck } from './deck';
import { getCapturePlan, getLoosePlacementOptions } from './placement';

const cards = new Map(createDeck().map((card) => [card.id, card]));
const card = (id: Parameters<typeof cards.get>[0]) => cards.get(id)!;

describe('loose-card placement choices', () => {
  it('partitions a direct match and a sum into separate capture groups', () => {
    const plan = getCapturePlan([
      card('clubs-9'),
      card('spades-2'),
      card('diamonds-7'),
    ], 9);

    expect(plan?.groups).toEqual([
      ['clubs-9'],
      ['spades-2', 'diamonds-7'],
    ]);
  });

  it('keeps Take 4, Stay 4, and Build 8 as separate choices for 4 on 4', () => {
    const played = card('hearts-4');
    const options = getLoosePlacementOptions(
      played,
      [card('clubs-4')],
      [played, card('diamonds-4'), card('spades-8')],
    );
    expect(options).toEqual({
      choices: ['take', 'stay', 'build'],
      buildTarget: 8,
      looseTotal: 4,
      hasTakeExtension: false,
      hasBuildExtension: false,
    });
  });

  it('auto-resolves an unambiguous Ace plus 5 build when a 6 is retained', () => {
    const played = card('hearts-1');
    const options = getLoosePlacementOptions(
      played,
      [card('clubs-5')],
      [played, card('spades-6')],
    );
    expect(options.choices).toEqual(['build']);
    expect(options.buildTarget).toBe(6);
  });

  it('treats a plain matching placement with no retained support as Take only', () => {
    const played = card('hearts-4');
    const options = getLoosePlacementOptions(played, [card('clubs-4')], [played]);
    expect(options.choices).toEqual(['take']);
  });

  it('keeps 3 pending when a loose 4 can still complete a Take 7', () => {
    const played = card('hearts-7');
    const three = card('clubs-3');
    const four = card('diamonds-4');
    const options = getLoosePlacementOptions(
      played,
      [three],
      [played, card('spades-10')],
      [three, four],
    );
    expect(options.choices).toEqual(['build']);
    expect(options.buildTarget).toBe(10);
    expect(options.hasTakeExtension).toBe(true);
  });

  it('offers Take 7 after the loose 3 and 4 are both selected', () => {
    const played = card('hearts-7');
    const looseCards = [card('clubs-3'), card('diamonds-4')];
    const options = getLoosePlacementOptions(played, looseCards, [played], looseCards);
    expect(options.choices).toEqual(['take']);
    expect(options.hasTakeExtension).toBe(false);
  });

  it('also offers Stay 7 for loose 3 plus 4 when another 7 remains', () => {
    const played = card('hearts-7');
    const looseCards = [card('clubs-3'), card('diamonds-4')];
    const options = getLoosePlacementOptions(
      played,
      looseCards,
      [played, card('spades-7')],
      looseCards,
    );

    expect(options.choices).toEqual(['take', 'stay']);
  });

  it('keeps Ace plus 4 pending when loose 2 can extend it to a retained 7', () => {
    const played = card('hearts-1');
    const four = card('clubs-4');
    const two = card('diamonds-2');
    const options = getLoosePlacementOptions(
      played,
      [four],
      [played, card('spades-5'), card('spades-7')],
      [four, two],
    );

    expect(options.choices).toEqual(['build']);
    expect(options.buildTarget).toBe(5);
    expect(options.hasBuildExtension).toBe(true);
  });

  it('offers Build 7 after Ace, loose 4, and loose 2 are selected', () => {
    const played = card('hearts-1');
    const looseCards = [card('clubs-4'), card('diamonds-2')];
    const options = getLoosePlacementOptions(
      played,
      looseCards,
      [played, card('spades-7')],
      looseCards,
    );

    expect(options.choices).toEqual(['build']);
    expect(options.buildTarget).toBe(7);
    expect(options.hasBuildExtension).toBe(false);
  });

  it('keeps Build 10 pending when a loose 10 can join as another group', () => {
    const played = card('hearts-1');
    const nine = card('clubs-9');
    const looseTen = card('spades-10');
    const initial = getLoosePlacementOptions(
      played,
      [nine],
      [played, card('diamonds-10')],
      [nine, looseTen],
    );
    expect(initial.choices).toEqual(['build']);
    expect(initial.hasBuildExtension).toBe(true);

    const complete = getLoosePlacementOptions(
      played,
      [nine, looseTen],
      [played, card('diamonds-10')],
      [nine, looseTen],
    );
    expect(complete.choices).toEqual(['build']);
    expect(complete.buildTarget).toBe(10);
    expect(complete.hasBuildExtension).toBe(false);
  });
});
