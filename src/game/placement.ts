import { Card } from './types.js';

export type LoosePlacementChoice = 'take' | 'stay' | 'build';

export interface LoosePlacementOptions {
  choices: LoosePlacementChoice[];
  buildTarget: number;
  looseTotal: number;
  hasTakeExtension: boolean;
  hasBuildExtension: boolean;
}

export interface LooseBuildPlan {
  targetValue: Card['value'];
  primaryFloorCardIds: Card['id'][];
  additionalFloorGroups: Card['id'][][];
}

export interface CapturePlan {
  groups: Card['id'][][];
}

function hasSubsetTotal(cards: readonly Card[], target: number): boolean {
  if (target === 0) return true;
  if (target < 0) return false;
  return cards.some((card, index) => hasSubsetTotal(cards.slice(index + 1), target - card.value));
}

function findSubsets(cards: readonly Card[], target: number): Card[][] {
  if (target === 0) return [[]];
  if (target < 0) return [];
  const results: Card[][] = [];
  cards.forEach((card, index) => {
    for (const tail of findSubsets(cards.slice(index + 1), target - card.value)) {
      results.push([card, ...tail]);
    }
  });
  return results;
}

function partitionTargetGroups(cards: readonly Card[], target: number): Card[][] | null {
  if (cards.length === 0) return [];
  const [first, ...rest] = cards;
  for (const companions of findSubsets(rest, target - first.value)) {
    const used = new Set([first.id, ...companions.map((card) => card.id)]);
    const remaining = cards.filter((card) => !used.has(card.id));
    const nextGroups = partitionTargetGroups(remaining, target);
    if (nextGroups) return [[first, ...companions], ...nextGroups];
  }
  return null;
}

export function getCapturePlan(cards: readonly Card[], target: number): CapturePlan | null {
  const groups = partitionTargetGroups(cards, target);
  return groups && groups.length > 0
    ? { groups: groups.map((group) => group.map((card) => card.id)) }
    : null;
}

export function getLooseBuildPlan(
  handCard: Card,
  looseCards: readonly Card[],
  hand: readonly Card[],
): LooseBuildPlan | null {
  const retainedTargets = [...new Set(
    hand
      .filter((card) => card.id !== handCard.id && card.value > handCard.value)
      .map((card) => card.value),
  )].sort((left, right) => left - right);

  for (const targetValue of retainedTargets) {
    for (const primary of findSubsets(looseCards, targetValue - handCard.value)) {
      if (primary.length === 0) continue;
      const primaryIds = new Set(primary.map((card) => card.id));
      const remaining = looseCards.filter((card) => !primaryIds.has(card.id));
      const additionalGroups = partitionTargetGroups(remaining, targetValue);
      if (!additionalGroups) continue;
      return {
        targetValue,
        primaryFloorCardIds: primary.map((card) => card.id),
        additionalFloorGroups: additionalGroups.map((group) => group.map((card) => card.id)),
      };
    }
  }
  return null;
}

export function getLoosePlacementOptions(
  handCard: Card,
  looseCards: readonly Card[],
  hand: readonly Card[],
  allLooseCards: readonly Card[] = looseCards,
): LoosePlacementOptions {
  const looseTotal = looseCards.reduce((sum, card) => sum + card.value, 0);
  const buildPlan = getLooseBuildPlan(handCard, looseCards, hand);
  const buildTarget = buildPlan?.targetValue ?? handCard.value + looseTotal;
  const choices: LoosePlacementChoice[] = [];

  if (looseTotal === handCard.value) choices.push('take');
  if (
    looseCards.length > 0 &&
    looseTotal === handCard.value &&
    hand.some((card) => card.id !== handCard.id && card.value === handCard.value)
  ) choices.push('stay');
  if (buildPlan) choices.push('build');

  const selectedIds = new Set(looseCards.map((card) => card.id));
  const remainingLooseCards = allLooseCards.filter((card) => !selectedIds.has(card.id));
  const hasTakeExtension = looseTotal < handCard.value && hasSubsetTotal(
    remainingLooseCards,
    handCard.value - looseTotal,
  );
  const retainedTargets = [...new Set(
    hand
      .filter((card) => card.id !== handCard.id && card.value > handCard.value)
      .map((card) => card.value),
  )];
  const hasBuildExtension = retainedTargets.some((target) => {
    const firstGroupFloorTotal = target - handCard.value;
    if (looseTotal < firstGroupFloorTotal) {
      return hasSubsetTotal(remainingLooseCards, firstGroupFloorTotal - looseTotal);
    }
    const amountPastFirstGroup = looseTotal - firstGroupFloorTotal;
    const amountIntoNextGroup = amountPastFirstGroup % target;
    const needed = amountIntoNextGroup === 0 ? target : target - amountIntoNextGroup;
    return hasSubsetTotal(remainingLooseCards, needed);
  });

  return { choices, buildTarget, looseTotal, hasTakeExtension, hasBuildExtension };
}
