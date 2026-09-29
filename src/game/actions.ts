import { calculateScore } from './scoring.js';
import { orderBuildGroup } from './builds.js';
import { assertValidGameState } from './validation.js';
import {
  BeginMoveInput,
  Build,
  BuildCardRef,
  Card,
  CardId,
  CaptureCardRef,
  GameAction,
  GameState,
  PendingMove,
  PlayerId,
  ValidationResult,
} from './types.js';

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

function illegal(message: string): never {
  throw new IllegalMoveError(message);
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    deck: [...state.deck],
    floor: [...state.floor],
    builds: state.builds.map((build) => ({ ...build, orderedCards: [...build.orderedCards] })),
    players: Object.fromEntries(
      Object.entries(state.players).map(([id, player]) => [
        id,
        { ...player, hand: [...player.hand], captured: [...player.captured] },
      ]),
    ),
    pendingMove: state.pendingMove
      ? {
          ...state.pendingMove,
          orderedPublicCards: [...state.pendingMove.orderedPublicCards],
          groups: state.pendingMove.groups.map((group) => ({
            ...group,
            orderedCardIds: [...group.orderedCardIds],
          })),
        }
      : null,
    turnOrder: [...state.turnOrder],
    score: state.score
      ? {
          ...state.score,
          players: Object.fromEntries(
            Object.entries(state.score.players).map(([id, score]) => [id, { ...score }]),
          ),
          teams: state.score.teams
            ? Object.fromEntries(Object.entries(state.score.teams).map(([id, score]) => [id, { ...score }]))
            : undefined,
        }
      : null,
  };
}

function requirePlayable(state: GameState): void {
  if (state.phase === 'complete') illegal('The game is already complete.');
}

function requireTurn(state: GameState, playerId: PlayerId): void {
  requirePlayable(state);
  if (!state.players[playerId]) illegal(`Unknown player ${playerId}.`);
  if (state.currentPlayer !== playerId) illegal('It is not this player\'s turn.');
}

function hasClassicRoundOneRestrictions(state: GameState): boolean {
  return (state.mode ?? 'classic-1v1') === 'classic-1v1' && state.round === 1;
}

function findHandCard(state: GameState, playerId: PlayerId, cardId: CardId): Card {
  const card = state.players[playerId].hand.find((candidate) => candidate.id === cardId);
  if (!card) illegal('The selected card is not in the active player\'s hand.');
  return card;
}

function findBuild(state: GameState, buildId: string): Build {
  const build = state.builds.find((candidate) => candidate.id === buildId);
  if (!build) illegal(`Build ${buildId} does not exist.`);
  return build;
}

function areOpponents(state: GameState, first: PlayerId, second: PlayerId): boolean {
  if (first === second) return false;
  if ((state.mode ?? 'classic-1v1') !== 'partners-2v2') return true;
  return state.playerTeams?.[first] !== state.playerTeams?.[second];
}

function opponentIds(state: GameState, playerId: PlayerId): PlayerId[] {
  return state.turnOrder.filter((id) => areOpponents(state, playerId, id));
}

function controlsBuild(state: GameState, playerId: PlayerId, build: Build): boolean {
  if ((state.mode ?? 'classic-1v1') !== 'partners-2v2') return build.ownerPlayerId === playerId;
  return Boolean(build.ownerTeamId && build.ownerTeamId === state.playerTeams?.[playerId]);
}

function updateExposedCard(state: GameState, playerId: PlayerId): void {
  const captured = state.players[playerId].captured;
  state.players[playerId].exposedCapturedCardId = captured.at(-1)?.id ?? null;
}

function removeHandCard(state: GameState, playerId: PlayerId, cardId: CardId): Card {
  const hand = state.players[playerId].hand;
  const index = hand.findIndex((card) => card.id === cardId);
  if (index < 0) illegal('The committed card is no longer in the player\'s hand.');
  return hand.splice(index, 1)[0];
}

function removeFloorCard(state: GameState, cardId: CardId): Card {
  const index = state.floor.findIndex((card) => card.id === cardId);
  if (index < 0) illegal(`Floor card ${cardId} is not available.`);
  return state.floor.splice(index, 1)[0];
}

function removeExposedCard(
  state: GameState,
  actingPlayerId: PlayerId,
  playerId: PlayerId,
  cardId: CardId,
): Card {
  if (playerId === actingPlayerId) illegal('A player cannot use their own captured inventory.');
  if (!areOpponents(state, actingPlayerId, playerId)) illegal('Only an opposing inventory is public game.');
  const player = state.players[playerId];
  if (player.exposedCapturedCardId !== cardId) illegal('Only the currently exposed top card can be used.');
  const top = player.captured.at(-1);
  if (!top || top.id !== cardId) illegal('The exposed card is not the physical top of the inventory.');
  const removed = player.captured.pop()!;
  updateExposedCard(state, playerId);
  return removed;
}

function ownedBuild(state: GameState, playerId: PlayerId): Build | undefined {
  return state.builds.find((build) => controlsBuild(state, playerId, build));
}

function responsibleBuild(state: GameState, playerId: PlayerId): Build | undefined {
  return state.builds.find((build) => build.ownerPlayerId === playerId);
}

function retainedMatchingCards(
  state: GameState,
  playerId: PlayerId,
  targetValue: number,
  reservedCardId: CardId,
): Card[] {
  return state.players[playerId].hand.filter(
    (card) => card.id !== reservedCardId && card.value === targetValue,
  );
}

function sumCards(cards: Card[]): number {
  return cards.reduce((total, card) => total + card.value, 0);
}

function requireUniqueBuildTarget(state: GameState, targetValue: number, exceptBuildId?: string): void {
  if (state.builds.some((build) => build.id !== exceptBuildId && build.targetValue === targetValue)) {
    illegal(`A build for ${targetValue} already exists. Only one build of each value may be on the table.`);
  }
}

function findSubset(cards: Card[], target: number): Card[] | null {
  if (target === 0) return [];
  for (let mask = 1; mask < 1 << cards.length; mask += 1) {
    const selected: Card[] = [];
    let total = 0;
    for (let index = 0; index < cards.length; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        selected.push(cards[index]);
        total += cards[index].value;
      }
    }
    if (total === target) return selected;
  }
  return null;
}

function createBuild(
  state: GameState,
  playerId: PlayerId,
  targetValue: Card['value'],
  secured: boolean,
  orderedCards: Card[],
): void {
  requireUniqueBuildTarget(state, targetValue);
  state.builds.push({
    id: `build-${state.nextBuildSequence}`,
    targetValue,
    ownerPlayerId: playerId,
    ownerTeamId: state.playerTeams?.[playerId],
    tablePlayerId: playerId,
    secured,
    orderedCards,
    createdInRound: state.round,
  });
  state.nextBuildSequence += 1;
}

function nextPlayer(state: GameState, playerId: PlayerId): PlayerId {
  const index = state.turnOrder.indexOf(playerId);
  return state.turnOrder[(index + 1) % state.turnOrder.length];
}

function finishTurn(state: GameState, playerId: PlayerId): void {
  if (state.players[playerId].hand.length === 0 && state.builds.some((build) => build.ownerPlayerId === playerId)) {
    illegal('A player cannot finish their hand while their build remains unresolved.');
  }
  if ((state.mode ?? 'classic-1v1') === 'classic-1v1' && state.round === 1 && state.players[playerId].hand.length === 0) {
    state.lastPlayerToFinishRoundOne = playerId;
  }

  state.currentPlayer = nextPlayer(state, playerId);
  state.revision += 1;

  const handsEmpty = state.turnOrder.every((id) => state.players[id].hand.length === 0);
  const singleDealMode = (state.mode ?? 'classic-1v1') !== 'classic-1v1';
  if ((state.round === 2 || singleDealMode) && handsEmpty) {
    if (state.pendingMove || state.builds.length > 0) {
      illegal('Round 2 cannot end with an unresolved move or build.');
    }
    if (state.floor.length > 0) {
      if (!state.lastPlayerToCapture) {
        illegal('Remaining floor cards cannot be assigned because no player captured.');
      }
      const recipient = state.players[state.lastPlayerToCapture];
      recipient.captured.push(...state.floor);
      state.floor = [];
      updateExposedCard(state, recipient.id);
    }
    state.score = calculateScore(state);
    state.phase = 'complete';
  }

  assertValidGameState(state);
}

function assertPendingOwner(state: GameState, playerId: PlayerId): PendingMove {
  requireTurn(state, playerId);
  if (!state.pendingMove) illegal('There is no pending move.');
  if (state.pendingMove.playerId !== playerId) illegal('Only the pending move owner may continue it.');
  return state.pendingMove;
}

function validateBeginMode(state: GameState, input: BeginMoveInput, handCard: Card): BeginMoveInput {
  const own = ownedBuild(state, input.playerId);
  const responsible = responsibleBuild(state, input.playerId);
  let normalized = input;

  if (
    own &&
    own.ownerPlayerId === input.playerId &&
    handCard.value === own.targetValue &&
    retainedMatchingCards(state, input.playerId, own.targetValue, handCard.id).length === 0
  ) {
    if (input.mode !== 'capture' || input.selectedBuildId !== own.id) {
      normalized = { ...input, mode: 'capture', targetValue: own.targetValue, selectedBuildId: own.id };
    }
  }

  const build = normalized.selectedBuildId ? findBuild(state, normalized.selectedBuildId) : null;
  if (normalized.targetValue < 1 || normalized.targetValue > 10) illegal('Target value must be from 1 to 10.');

  switch (normalized.mode) {
    case 'capture':
      if (handCard.value !== normalized.targetValue) illegal('A capture must commit a matching target card.');
      if (build && build.targetValue !== normalized.targetValue) illegal('The hand card does not match the build.');
      if (
        build && controlsBuild(state, input.playerId, build) &&
        build.ownerPlayerId !== input.playerId
      ) {
        illegal('A partner cannot take the responsible player\'s build; continue it or declare Stay instead.');
      }
      if (hasClassicRoundOneRestrictions(state) && responsible && build && build.id !== responsible.id) {
        illegal('Round 1 requires the player to resolve their own build first.');
      }
      break;
    case 'normal-build':
      requireUniqueBuildTarget(state, normalized.targetValue);
      if (build) illegal('A normal build starts from loose public cards.');
      if (normalized.targetValue <= handCard.value) illegal('A normal build must increase to its target value.');
      if (retainedMatchingCards(state, input.playerId, normalized.targetValue, handCard.id).length === 0) {
        illegal('A normal build must retain a matching target card in hand.');
      }
      break;
    case 'stay':
      requireUniqueBuildTarget(state, normalized.targetValue);
      if (normalized.targetValue !== handCard.value) illegal('Stay must use the matching target value.');
      if (retainedMatchingCards(state, input.playerId, normalized.targetValue, handCard.id).length === 0) {
        illegal('Stay requires another matching target card to remain in hand.');
      }
      break;
    case 'continue-build':
      if (!build || !controlsBuild(state, input.playerId, build)) illegal('A player may only continue their own or team build.');
      if (normalized.targetValue !== build.targetValue) illegal('Continue Build keeps the existing target value.');
      if (retainedMatchingCards(state, input.playerId, normalized.targetValue, handCard.id).length === 0) {
        illegal('Continuing a build requires its matching target card to remain in hand.');
      }
      break;
    case 'manipulate-build':
      if (!build || controlsBuild(state, input.playerId, build)) illegal('Only an opponent build may be manipulated.');
      requireUniqueBuildTarget(state, normalized.targetValue, build.id);
      if (build.secured) illegal('A secured build cannot be manipulated.');
      if (build.targetValue === 10) illegal('A 10-build cannot be manipulated upward.');
      if (normalized.targetValue <= build.targetValue || normalized.targetValue > 10) {
        illegal('The unsecured build must be manipulated upward to a maximum of 10.');
      }
      if (retainedMatchingCards(state, input.playerId, normalized.targetValue, handCard.id).length === 0) {
        illegal('Manipulation requires a matching new target card to remain in hand.');
      }
      break;
    case 'secure-build':
      if (!build || !controlsBuild(state, input.playerId, build)) illegal('A player may only secure their own or team build.');
      if (handCard.value !== build.targetValue) illegal('Securing requires a matching target card.');
      if (retainedMatchingCards(state, input.playerId, normalized.targetValue, handCard.id).length === 0) {
        illegal('Stay on a build requires another matching target card to remain in hand.');
      }
      break;
  }

  return normalized;
}

export function beginMove(state: GameState, input: BeginMoveInput): GameState {
  requireTurn(state, input.playerId);
  if (state.pendingMove) illegal('Finish the pending move before starting another action.');
  const handCard = findHandCard(state, input.playerId, input.reservedHandCardId);
  const normalized = validateBeginMode(state, input, handCard);
  const next = cloneState(state);

  next.pendingMove = {
    id: next.nextPendingMoveSequence,
    playerId: normalized.playerId,
    mode: normalized.mode,
    targetValue: normalized.targetValue,
    reservedHandCardId: normalized.reservedHandCardId,
    selectedBuildId: normalized.selectedBuildId ?? null,
    orderedPublicCards: [],
    groups: [],
    stage: 'declared',
    startedInRound: next.round,
  };
  next.nextPendingMoveSequence += 1;
  next.revision += 1;
  assertValidGameState(next);
  return next;
}

function resolvePublicRef(state: GameState, playerId: PlayerId, ref: CaptureCardRef): Card {
  if (ref.source === 'floor') return removeFloorCard(state, ref.cardId);
  return removeExposedCard(state, playerId, ref.playerId, ref.cardId);
}

function assertUniqueRefs(refs: CaptureCardRef[]): void {
  const ids = refs.map((ref) => ref.cardId);
  if (new Set(ids).size !== ids.length) illegal('A physical card can only participate once in a group.');
}

function validatePublicGroup(
  pending: PendingMove,
  cards: Card[],
  purpose: PendingMove['groups'][number]['purpose'],
): void {
  if (cards.length === 0) illegal('Select at least one public card.');
  const publicTotal = sumCards(cards);

  if (purpose === 'extra-capture') {
    if (pending.mode !== 'capture') illegal('Extra capture groups are only valid during a capture.');
    if (publicTotal !== pending.targetValue) illegal('Each extra capture group must equal the declared target.');
    return;
  }
  if (purpose === 'additional-build-group') {
    if (
      pending.mode !== 'normal-build' &&
      pending.mode !== 'stay' &&
      pending.mode !== 'continue-build' &&
      pending.mode !== 'secure-build'
    ) {
      illegal('Additional build groups are only valid while creating or staying on a build.');
    }
    if (publicTotal !== pending.targetValue) illegal('Each additional build group must equal the build target.');
    return;
  }

  if (pending.groups.some((group) => group.purpose === 'primary')) {
    illegal('The primary public-card group has already been resolved.');
  }

  switch (pending.mode) {
    case 'capture':
      if (publicTotal !== pending.targetValue) illegal('The selected capture set must equal the target value.');
      break;
    case 'normal-build': {
      const handValue = pending.reservedHandCardId.split('-').at(-1);
      if (publicTotal + Number(handValue) !== pending.targetValue) illegal('The build math does not equal its target.');
      break;
    }
    case 'stay':
      if (publicTotal !== pending.targetValue) illegal('The selected Stay group must equal the target.');
      break;
    case 'continue-build': {
      const handValue = pending.reservedHandCardId.split('-').at(-1);
      if (publicTotal + Number(handValue) !== pending.targetValue) illegal('The continuation must equal the build target.');
      break;
    }
    case 'manipulate-build':
      break;
    case 'secure-build':
      illegal('Securing a build does not resolve a public-card group.');
  }
}

export function resolvePendingPublicGroup(
  state: GameState,
  playerId: PlayerId,
  refs: CaptureCardRef[],
  purpose: PendingMove['groups'][number]['purpose'] = 'primary',
): GameState {
  const pending = assertPendingOwner(state, playerId);
  if (
    hasClassicRoundOneRestrictions(state) &&
    responsibleBuild(state, playerId) &&
    pending.mode === 'capture' &&
    !pending.selectedBuildId &&
    refs.some((ref) => ref.source === 'exposed')
  ) {
    illegal('Round 1 only permits a separate capture from loose floor cards while owning a build.');
  }
  if (
    pending.mode === 'capture' &&
    purpose === 'primary' &&
    !pending.selectedBuildId &&
    refs.some((ref) => ref.source === 'exposed')
  ) {
    illegal('An exposed inventory card cannot start a Take without an existing floor game for the target.');
  }
  assertUniqueRefs(refs);
  const next = cloneState(state);
  const cards = refs.map((ref) => resolvePublicRef(next, playerId, ref));
  validatePublicGroup(pending, cards, purpose);

  if (pending.mode === 'manipulate-build' && purpose === 'primary') {
    const build = findBuild(next, pending.selectedBuildId!);
    const handCard = findHandCard(next, playerId, pending.reservedHandCardId);
    if (build.targetValue + handCard.value + sumCards(cards) !== pending.targetValue) {
      illegal('The manipulated build math does not equal the new target.');
    }
  }

  const orderedCards = orderBuildGroup(cards);
  next.pendingMove!.orderedPublicCards.push(...orderedCards);
  next.pendingMove!.groups.push({ purpose, orderedCardIds: orderedCards.map((card) => card.id) });
  next.pendingMove!.stage = 'resolving-public-cards';
  next.revision += 1;
  assertValidGameState(next);
  return next;
}

export function getRequiredExposedGroup(state: GameState): CaptureCardRef[] | null {
  const pending = state.pendingMove;
  if (!pending || (pending.mode !== 'capture' && pending.mode !== 'secure-build')) return null;
  const hasTargetGame = Boolean(pending.selectedBuildId || pending.groups.length > 0);
  if (!hasTargetGame) return null;
  for (const opponentId of opponentIds(state, pending.playerId)) {
    const exposedId = state.players[opponentId].exposedCapturedCardId;
    if (!exposedId) continue;
    const exposed = state.players[opponentId].captured.at(-1);
    if (!exposed || exposed.id !== exposedId || exposed.value > pending.targetValue) continue;
    const floorCards = findSubset(state.floor, pending.targetValue - exposed.value);
    if (!floorCards) continue;
    return [
      { source: 'exposed', playerId: opponentId, cardId: exposed.id },
      ...floorCards.map((card) => ({ source: 'floor' as const, cardId: card.id })),
    ];
  }
  return null;
}

export function getRequiredMatchingBuildGroup(state: GameState): CaptureCardRef[] | null {
  const pending = state.pendingMove;
  if (!pending) return null;
  const hasPrimary = pending.groups.some((group) => group.purpose === 'primary');
  const hasBuildAnchor = Boolean(
    (pending.selectedBuildId && (
      pending.mode === 'capture' ||
      pending.mode === 'continue-build' ||
      pending.mode === 'secure-build'
    )) ||
    ((pending.mode === 'normal-build' || pending.mode === 'stay') && hasPrimary)
  );
  if (!hasBuildAnchor) return null;

  const looseMatch = state.floor.find((card) => card.value === pending.targetValue);
  if (looseMatch) return [{ source: 'floor', cardId: looseMatch.id }];

  for (const opponentId of opponentIds(state, pending.playerId)) {
    const exposed = state.players[opponentId].captured.at(-1);
    if (exposed?.value === pending.targetValue) {
      return [{ source: 'exposed', playerId: opponentId, cardId: exposed.id }];
    }
  }
  return null;
}

function resolveRequiredBuildMatches(state: GameState, playerId: PlayerId): GameState {
  let next = state;
  let required = getRequiredMatchingBuildGroup(next);
  while (required) {
    const purpose = next.pendingMove?.mode === 'capture' ? 'extra-capture' : 'additional-build-group';
    next = resolvePendingPublicGroup(next, playerId, required, purpose);
    required = getRequiredMatchingBuildGroup(next);
  }
  return next;
}

function assertReadyToCommit(state: GameState, pending: PendingMove): void {
  const primary = pending.groups.find((group) => group.purpose === 'primary');
  if (getRequiredMatchingBuildGroup(state)) {
    illegal('Every loose or exposed card matching the build target must join before the move finishes.');
  }
  if (pending.mode === 'capture') {
    if (!pending.selectedBuildId && pending.groups.length === 0) illegal('A capture needs a selected legal set.');
    if (getRequiredExposedGroup(state)) {
      illegal('Resolve every applicable exposed top-card game before taking cards home.');
    }
    return;
  }
  if (pending.mode === 'secure-build') {
    if (getRequiredExposedGroup(state)) {
      illegal('Resolve every applicable exposed top-card game before completing Stay.');
    }
    return;
  }
  if (pending.mode === 'manipulate-build') {
    const build = findBuild(state, pending.selectedBuildId!);
    const hand = findHandCard(state, pending.playerId, pending.reservedHandCardId);
    const total = build.targetValue + hand.value + sumCards(pending.orderedPublicCards);
    if (total !== pending.targetValue) illegal('The manipulated build math is incomplete.');
    return;
  }
  if (!primary) illegal('Resolve the public-card group before committing the hand card.');
}

export function commitPendingMove(state: GameState, playerId: PlayerId): GameState {
  const pending = assertPendingOwner(state, playerId);
  assertReadyToCommit(state, pending);
  const next = cloneState(state);
  const move = next.pendingMove!;
  const handCard = removeHandCard(next, playerId, move.reservedHandCardId);

  switch (move.mode) {
    case 'capture': {
      const captured = [...move.orderedPublicCards];
      if (move.selectedBuildId) {
        const buildIndex = next.builds.findIndex((build) => build.id === move.selectedBuildId);
        if (buildIndex < 0) illegal('The selected build no longer exists.');
        captured.push(...next.builds.splice(buildIndex, 1)[0].orderedCards);
      }
      captured.push(handCard);
      next.players[playerId].captured.push(...captured);
      updateExposedCard(next, playerId);
      next.lastPlayerToCapture = playerId;
      break;
    }
    case 'normal-build':
      {
        const publicCards = new Map(move.orderedPublicCards.map((card) => [card.id, card]));
        const orderedGroups = move.groups.map((group) => {
          const publicGroup = group.orderedCardIds.map((id) => publicCards.get(id)!);
          return group.purpose === 'primary'
            ? orderBuildGroup([...publicGroup, handCard])
            : orderBuildGroup(publicGroup);
        });
        const secured = move.groups.some((group) => group.purpose === 'additional-build-group');
        createBuild(next, playerId, move.targetValue, secured, orderedGroups.flat());
      }
      break;
    case 'stay':
      createBuild(next, playerId, move.targetValue, true, [...move.orderedPublicCards, handCard]);
      break;
    case 'continue-build': {
      const build = findBuild(next, move.selectedBuildId!);
      const publicCards = new Map(move.orderedPublicCards.map((card) => [card.id, card]));
      const primaryIds = move.groups.find((group) => group.purpose === 'primary')?.orderedCardIds ?? [];
      const primaryCards = primaryIds.map((id) => publicCards.get(id)!);
      const additionalGroups = move.groups
        .filter((group) => group.purpose === 'additional-build-group')
        .map((group) => group.orderedCardIds.map((id) => publicCards.get(id)!));
      build.orderedCards.push(
        ...orderBuildGroup([...primaryCards, handCard]),
        ...additionalGroups.flatMap(orderBuildGroup),
      );
      build.secured = true;
      break;
    }
    case 'manipulate-build': {
      const build = findBuild(next, move.selectedBuildId!);
      build.orderedCards = orderBuildGroup([...build.orderedCards, ...move.orderedPublicCards, handCard]);
      build.targetValue = move.targetValue;
      build.ownerPlayerId = playerId;
      build.ownerTeamId = next.playerTeams?.[playerId];
      build.tablePlayerId = playerId;
      build.secured = false;
      break;
    }
    case 'secure-build': {
      const build = findBuild(next, move.selectedBuildId!);
      build.orderedCards.push(...move.orderedPublicCards, handCard);
      build.secured = true;
      if ((next.mode ?? 'classic-1v1') === 'partners-2v2') {
        build.ownerPlayerId = playerId;
        build.ownerTeamId = next.playerTeams?.[playerId];
      }
      break;
    }
  }

  next.pendingMove = null;
  finishTurn(next, playerId);
  return next;
}

export function dropCard(state: GameState, playerId: PlayerId, cardId: CardId): GameState {
  requireTurn(state, playerId);
  if (state.pendingMove) illegal('Finish the pending move before dropping a card.');
  const own = responsibleBuild(state, playerId);
  const card = findHandCard(state, playerId, cardId);
  if (
    own &&
    own.ownerPlayerId === playerId &&
    card.value === own.targetValue &&
    retainedMatchingCards(state, playerId, own.targetValue, card.id).length === 0
  ) {
    let next = beginMove(state, {
      playerId,
      mode: 'capture',
      reservedHandCardId: card.id,
      targetValue: own.targetValue,
      selectedBuildId: own.id,
    });
    let required = getRequiredExposedGroup(next);
    while (required) {
      next = resolvePendingPublicGroup(next, playerId, required, 'extra-capture');
      required = getRequiredExposedGroup(next);
    }
    return commitPendingMove(next, playerId);
  }
  if (own && hasClassicRoundOneRestrictions(state)) {
    illegal('Classic Round 1 blocks an unrelated drop while the player owns a build.');
  }
  const next = cloneState(state);
  next.floor.push(removeHandCard(next, playerId, cardId));
  finishTurn(next, playerId);
  return next;
}

function publicRefsFromBuildRefs(refs: BuildCardRef[]): CaptureCardRef[] {
  return refs
    .filter((ref): ref is Exclude<BuildCardRef, { source: 'hand' }> => ref.source !== 'hand')
    .map((ref) => ref);
}

export function applyGameAction(state: GameState, action: GameAction): GameState {
  if (action.type === 'drop') return dropCard(state, action.playerId, action.cardId);

  if (action.type === 'partner-stay') {
    requireTurn(state, action.playerId);
    if ((state.mode ?? 'classic-1v1') !== 'partners-2v2' || !state.playerTeams) {
      illegal('Partner Stay is only available in Partners 2v2.');
    }
    if (
      action.playerId === action.partnerPlayerId ||
      state.playerTeams[action.playerId] !== state.playerTeams[action.partnerPlayerId]
    ) {
      illegal('Partner Stay must be called by the active player\'s opposite-seat partner.');
    }
    const build = findBuild(state, action.buildId);
    if (!controlsBuild(state, action.playerId, build)) illegal('Partner Stay requires the team\'s own build.');
    const handCard = findHandCard(state, action.playerId, action.cardId);
    if (handCard.value !== build.targetValue) illegal('The active player must supply the matching build card.');
    if (!state.players[action.partnerPlayerId].hand.some((card) => card.value === build.targetValue)) {
      illegal('The partner must privately retain a matching target card.');
    }

    let next = beginMove(state, {
      playerId: action.playerId,
      mode: 'capture',
      reservedHandCardId: action.cardId,
      targetValue: build.targetValue,
      selectedBuildId: build.id,
    });
    let required = getRequiredMatchingBuildGroup(next) ?? getRequiredExposedGroup(next);
    while (required) {
      next = resolvePendingPublicGroup(next, action.playerId, required, 'extra-capture');
      required = getRequiredMatchingBuildGroup(next) ?? getRequiredExposedGroup(next);
    }

    const result = cloneState(next);
    const pending = result.pendingMove!;
    const suppliedCard = removeHandCard(result, action.playerId, action.cardId);
    const teamBuild = findBuild(result, action.buildId);
    teamBuild.orderedCards.push(...pending.orderedPublicCards, suppliedCard);
    teamBuild.secured = true;
    teamBuild.ownerPlayerId = action.partnerPlayerId;
    teamBuild.ownerTeamId = result.playerTeams![action.partnerPlayerId];
    result.pendingMove = null;
    finishTurn(result, action.playerId);
    return result;
  }

  if (action.type === 'create-build') {
    const primaryRefs = action.publicCards ?? action.floorCardIds.map((cardId) => ({ source: 'floor' as const, cardId }));
    const additionalGroups = action.additionalPublicGroups ?? (action.additionalFloorGroups ?? []).map(
      (group) => group.map((cardId) => ({ source: 'floor' as const, cardId })),
    );
    const primaryUsesExposed = primaryRefs.some((ref) => ref.source === 'exposed');
    const explicitLooseTargetAnchorIndex = primaryUsesExposed
      ? additionalGroups.findIndex((group) => group.length === 1 && group[0].source === 'floor' && (
        state.floor.find((card) => card.id === group[0].cardId)?.value === action.targetValue
      ))
      : -1;
    const explicitlyUsedIds = new Set([
      ...primaryRefs.map((ref) => ref.cardId),
      ...additionalGroups.flatMap((group) => group.map((ref) => ref.cardId)),
    ]);
    const implicitLooseTargetAnchor = primaryUsesExposed && explicitLooseTargetAnchorIndex < 0
      ? state.floor.find((card) => card.value === action.targetValue && !explicitlyUsedIds.has(card.id))
      : undefined;
    if (primaryUsesExposed && explicitLooseTargetAnchorIndex < 0 && !implicitLooseTargetAnchor) {
        illegal('An exposed card can only join a new build when a loose target card already anchors it.');
    }
    let next = beginMove(state, {
      playerId: action.playerId,
      mode: 'normal-build',
      reservedHandCardId: action.playedCardId,
      targetValue: action.targetValue,
    });
    if (explicitLooseTargetAnchorIndex >= 0) {
      next = resolvePendingPublicGroup(
        next,
        action.playerId,
        additionalGroups[explicitLooseTargetAnchorIndex],
        'additional-build-group',
      );
    } else if (implicitLooseTargetAnchor) {
      next = resolvePendingPublicGroup(next, action.playerId, [{
        source: 'floor',
        cardId: implicitLooseTargetAnchor.id,
      }], 'additional-build-group');
    }
    next = resolvePendingPublicGroup(
      next,
      action.playerId,
      primaryRefs,
    );
    for (const [index, group] of additionalGroups.entries()) {
      if (index === explicitLooseTargetAnchorIndex) continue;
      next = resolvePendingPublicGroup(
        next,
        action.playerId,
        group,
        'additional-build-group',
      );
    }
    next = resolveRequiredBuildMatches(next, action.playerId);
    return commitPendingMove(next, action.playerId);
  }

  if (action.type === 'stay-build') {
    const card = findHandCard(state, action.playerId, action.playedCardId);
    let next = beginMove(state, {
      playerId: action.playerId,
      mode: 'stay',
      reservedHandCardId: action.playedCardId,
      targetValue: card.value,
    });
    next = resolvePendingPublicGroup(next, action.playerId, [
      ...action.floorCardIds.map((cardId) => ({ source: 'floor' as const, cardId })),
    ]);
    next = resolveRequiredBuildMatches(next, action.playerId);
    return commitPendingMove(next, action.playerId);
  }

  if (action.type === 'secure-build') {
    const build = findBuild(state, action.buildId);
    let next = beginMove(state, {
      playerId: action.playerId,
      mode: 'secure-build',
      reservedHandCardId: action.cardId,
      targetValue: build.targetValue,
      selectedBuildId: action.buildId,
    });
    for (const group of action.publicGroups ?? []) {
      next = resolvePendingPublicGroup(next, action.playerId, group, 'additional-build-group');
    }
    next = resolveRequiredBuildMatches(next, action.playerId);
    let required = getRequiredExposedGroup(next);
    while (required) {
      next = resolvePendingPublicGroup(next, action.playerId, required, 'additional-build-group');
      required = getRequiredExposedGroup(next);
    }
    return commitPendingMove(next, action.playerId);
  }

  if (action.type === 'continue-build' || action.type === 'manipulate-build') {
    const handRefs = action.cards.filter((ref) => ref.source === 'hand');
    if (handRefs.length !== 1) illegal('Exactly one active hand card must participate in the move.');
    const build = findBuild(state, action.buildId);
    let next = beginMove(state, {
      playerId: action.playerId,
      mode: action.type === 'continue-build' ? 'continue-build' : 'manipulate-build',
      reservedHandCardId: handRefs[0].cardId,
      targetValue: action.type === 'continue-build' ? build.targetValue : action.newTargetValue,
      selectedBuildId: action.buildId,
    });
    const publicRefs = publicRefsFromBuildRefs(action.cards);
    if (publicRefs.length > 0) next = resolvePendingPublicGroup(next, action.playerId, publicRefs);
    if (action.type === 'continue-build') {
      for (const group of action.additionalPublicGroups ?? []) {
        next = resolvePendingPublicGroup(next, action.playerId, group, 'additional-build-group');
      }
      next = resolveRequiredBuildMatches(next, action.playerId);
    }
    return commitPendingMove(next, action.playerId);
  }

  const buildGroups = action.groups.filter((group) => group.type === 'build');
  if (buildGroups.length > 1) illegal('A move may take one build at a time.');
  const handCard = findHandCard(state, action.playerId, action.playedCardId);
  let next = beginMove(state, {
    playerId: action.playerId,
    mode: 'capture',
    reservedHandCardId: action.playedCardId,
    targetValue: handCard.value,
    selectedBuildId: buildGroups[0]?.buildId,
  });
  const cardGroups = action.groups.filter((group) => group.type === 'cards');
  const explicitlySelectedIds = new Set(
    cardGroups.flatMap((group) => group.cards.map((ref) => ref.cardId)),
  );
  let required = getRequiredExposedGroup(next);
  while (required?.length === 1 && !explicitlySelectedIds.has(required[0].cardId)) {
    next = resolvePendingPublicGroup(next, action.playerId, required, 'extra-capture');
    required = getRequiredExposedGroup(next);
  }
  cardGroups.forEach((group, index) => {
    next = resolvePendingPublicGroup(next, action.playerId, group.cards, index === 0 ? 'primary' : 'extra-capture');
  });
  next = resolveRequiredBuildMatches(next, action.playerId);
  required = getRequiredExposedGroup(next);
  while (required) {
    next = resolvePendingPublicGroup(next, action.playerId, required, 'extra-capture');
    required = getRequiredExposedGroup(next);
  }
  return commitPendingMove(next, action.playerId);
}

export function validateGameAction(state: GameState, action: GameAction): ValidationResult {
  try {
    applyGameAction(state, action);
    return { valid: true, errors: [] };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'Unknown move validation error.'],
    };
  }
}
