import type { BuildId, Card, CardId, GameState, PlayerId } from './game';

export interface MoveFeedback {
  actorPlayerId: PlayerId;
  choice: 'drop' | 'take';
  floorCardIds: CardId[];
  buildId: BuildId | null;
  exposedInventory: boolean;
  exposedCardTaken: Card | null;
  revealedCard: Card | null;
}

function cardsChanged(before: Card[], after: Card[]) {
  return before.length !== after.length || before.some((card, index) => card.id !== after[index]?.id);
}

export function describeMoveFeedback(
  before: GameState,
  after: GameState,
  viewerPlayerId: PlayerId,
): MoveFeedback | null {
  if (after.revision <= before.revision) return null;

  const actorPlayerId = before.currentPlayer;
  const actorBefore = before.players[actorPlayerId];
  const actorAfter = after.players[actorPlayerId];
  const viewerBefore = before.players[viewerPlayerId];
  const viewerAfter = after.players[viewerPlayerId];
  if (!actorBefore || !actorAfter || !viewerBefore || !viewerAfter) return null;

  const floorCardIds = before.floor
    .filter((card) => !after.floor.some((remaining) => remaining.id === card.id))
    .map((card) => card.id);
  const changedBuild = after.builds.find((build) => {
    const previous = before.builds.find((candidate) => candidate.id === build.id);
    return !previous || cardsChanged(previous.orderedCards, build.orderedCards);
  });
  const removedBuild = before.builds.find((build) => !after.builds.some((candidate) => candidate.id === build.id));
  const oldExposed = viewerBefore.captured.at(-1) ?? null;
  const exposedInventory = Boolean(
    actorPlayerId !== viewerPlayerId &&
    oldExposed &&
    !viewerAfter.captured.some((card) => card.id === oldExposed.id),
  );
  const captured = actorAfter.captured.length > actorBefore.captured.length;

  return {
    actorPlayerId,
    choice: captured ? 'take' : 'drop',
    floorCardIds,
    buildId: changedBuild?.id ?? removedBuild?.id ?? null,
    exposedInventory,
    exposedCardTaken: exposedInventory ? oldExposed : null,
    revealedCard: exposedInventory ? viewerAfter.captured.at(-1) ?? null : null,
  };
}
