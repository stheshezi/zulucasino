import { Build, Card } from './types';

export function orderBuildGroup(cards: readonly Card[]): Card[] {
  return [...cards].sort((left, right) => right.value - left.value);
}

export function getBuildCardGroups(build: Build): Card[][] {
  const groups: Card[][] = [];
  let current: Card[] = [];
  let total = 0;

  for (const card of build.orderedCards) {
    current.push(card);
    total += card.value;
    if (total === build.targetValue) {
      groups.push(current);
      current = [];
      total = 0;
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

export function getBuildDisplayGroups(build: Build): Card[][] {
  return getBuildCardGroups(build).map(orderBuildGroup);
}
