import { Card, Player } from './types';

export interface DealRule {
  name: string;
  validate(hands: readonly (readonly Card[])[]): boolean;
}

export const noFourTensInOneHand: DealRule = {
  name: 'No player may receive all four 10s in one round',
  validate: (hands) => hands.every((hand) => hand.filter((card) => card.value === 10).length < 4),
};

export const ROUND_DEAL_RULES: readonly DealRule[] = [noFourTensInOneHand];

export function isRoundDealValid(
  hands: readonly (readonly Card[])[],
  rules: readonly DealRule[] = ROUND_DEAL_RULES,
): boolean {
  return rules.every((rule) => rule.validate(hands));
}

export function getExposedCapturedCard(player: Player): Card | null {
  if (player.exposedCapturedCardId === null) return null;
  return player.captured.find((card) => card.id === player.exposedCapturedCardId) ?? null;
}
