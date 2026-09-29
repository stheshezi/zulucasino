import { createDeck, DECK_SIZE } from './deck';
import { GameState, ValidationResult } from './types';

export function validateGameState(state: GameState): ValidationResult {
  const errors: string[] = [];
  const canonicalCards = new Map(createDeck().map((card) => [card.id, card]));
  const knownIds = new Set(canonicalCards.keys());
  const locations = [
    ['deck', state.deck],
    ['floor', state.floor],
    ...(state.pendingMove
      ? [['pendingMove', state.pendingMove.orderedPublicCards] as const]
      : []),
    ...state.builds.map((build) => [`build.${build.id}`, build.orderedCards] as const),
    ...Object.values(state.players).flatMap((player) => [
      [`${player.id}.hand`, player.hand] as const,
      [`${player.id}.captured`, player.captured] as const,
    ]),
  ] as const;
  const seen = new Map<string, string>();

  for (const [location, cards] of locations) {
    for (const card of cards) {
      const canonicalCard = canonicalCards.get(card.id);
      if (!canonicalCard) {
        errors.push(`Unknown card ${card.id} in ${location}.`);
      } else if (card.suit !== canonicalCard.suit || card.value !== canonicalCard.value) {
        errors.push(`Card ${card.id} has mismatched suit or value data in ${location}.`);
      }

      const previousLocation = seen.get(card.id);
      if (previousLocation) {
        errors.push(`Card ${card.id} appears in both ${previousLocation} and ${location}.`);
      } else {
        seen.set(card.id, location);
      }
    }
  }

  for (const id of knownIds) {
    if (!seen.has(id)) errors.push(`Card ${id} is missing from the game state.`);
  }

  if (seen.size !== DECK_SIZE) {
    errors.push(`Expected ${DECK_SIZE} unique cards, found ${seen.size}.`);
  }

  for (const player of Object.values(state.players)) {
    if (
      player.exposedCapturedCardId !== null &&
      !player.captured.some((card) => card.id === player.exposedCapturedCardId)
    ) {
      errors.push(`${player.id}'s exposed captured card is not in their captured inventory.`);
    }
    if (player.exposedCapturedCardId !== (player.captured.at(-1)?.id ?? null)) {
      errors.push(`${player.id}'s exposed captured card is not the physical top of their inventory.`);
    }
  }

  const buildIds = new Set<string>();
  const buildOwners = new Set<string>();
  for (const build of state.builds) {
    if (buildIds.has(build.id)) errors.push(`Build ID ${build.id} is duplicated.`);
    buildIds.add(build.id);
    if (!state.players[build.ownerPlayerId]) errors.push(`Build ${build.id} has an unknown owner.`);
    if (build.tablePlayerId && !state.players[build.tablePlayerId]) {
      errors.push(`Build ${build.id} has an unknown table position.`);
    }
    const ownershipKey = build.ownerTeamId ?? build.ownerPlayerId;
    if (buildOwners.has(ownershipKey)) {
      errors.push(`${ownershipKey} owns more than one active build.`);
    }
    buildOwners.add(ownershipKey);
    if (build.ownerTeamId && state.playerTeams?.[build.ownerPlayerId] !== build.ownerTeamId) {
      errors.push(`Build ${build.id} owner is not a member of its owning team.`);
    }
    if (!build.orderedCards.length) errors.push(`Build ${build.id} has no physical cards.`);
    if (build.targetValue < 1 || build.targetValue > 10) errors.push(`Build ${build.id} has an invalid target.`);
    if (build.createdInRound !== 1 && build.createdInRound !== 2) {
      errors.push(`Build ${build.id} has an invalid creation round.`);
    }
  }

  if (!Number.isInteger(state.nextBuildSequence) || state.nextBuildSequence < 1) {
    errors.push('Next build sequence must be a positive integer.');
  }
  if (!Number.isInteger(state.nextPendingMoveSequence) || state.nextPendingMoveSequence < 1) {
    errors.push('Next pending move sequence must be a positive integer.');
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('Revision must be non-negative.');

  if (state.pendingMove) {
    const pending = state.pendingMove;
    if (pending.playerId !== state.currentPlayer) errors.push('Pending move does not belong to the current player.');
    if (!state.players[pending.playerId]) errors.push('Pending move references an unknown player.');
    if (!state.players[pending.playerId]?.hand.some((card) => card.id === pending.reservedHandCardId)) {
      errors.push('Pending move reserved card is not in the active player hand.');
    }
    if (pending.selectedBuildId && !state.builds.some((build) => build.id === pending.selectedBuildId)) {
      errors.push('Pending move references an unknown build.');
    }
  }

  if (state.phase === 'complete') {
    const capturedCount = Object.values(state.players).reduce((sum, player) => sum + player.captured.length, 0);
    if (state.deck.length || state.floor.length || state.builds.length || state.pendingMove) {
      errors.push('Completed game still has cards outside captured inventories.');
    }
    if (Object.values(state.players).some((player) => player.hand.length)) {
      errors.push('Completed game still has cards in a hand.');
    }
    if (capturedCount !== 40) errors.push('Completed game must contain 40 captured cards.');
    if (!state.score) errors.push('Completed game is missing its score.');
  }

  if (new Set(state.turnOrder).size !== state.turnOrder.length) {
    errors.push('Turn order contains a duplicate player.');
  }
  if (state.turnOrder.some((playerId) => !state.players[playerId])) {
    errors.push('Turn order references an unknown player.');
  }
  if (!state.players[state.currentPlayer]) {
    errors.push('Current player does not exist in the player collection.');
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidGameState(state: GameState): GameState {
  const result = validateGameState(state);
  if (!result.valid) throw new Error(`Invalid game state:\n${result.errors.join('\n')}`);
  return state;
}
