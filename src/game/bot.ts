import {
  applyGameAction,
  beginMove,
  commitPendingMove,
  getRequiredExposedGroup,
  getRequiredMatchingBuildGroup,
  resolvePendingPublicGroup,
} from './actions';
import { Card, CaptureCardRef, GameState, PlayerId } from './types';

export type BotDifficulty = 'easy' | 'medium' | 'hard';

export interface BotDecision {
  state: GameState;
  strategy: string;
}

function findSubset(cards: Card[], target: number): Card[] | null {
  function visit(index: number, remaining: number, selected: Card[]): Card[] | null {
    if (remaining === 0) return selected;
    if (remaining < 0 || index >= cards.length) return null;
    return (
      visit(index + 1, remaining - cards[index].value, [...selected, cards[index]]) ??
      visit(index + 1, remaining, selected)
    );
  }
  return visit(0, target, []);
}

function firstPublicCapture(state: GameState, playerId: PlayerId, target: number): CaptureCardRef[] | null {
  const floorSet = findSubset(state.floor, target);
  if (floorSet?.length) {
    return floorSet.map((card) => ({ source: 'floor', cardId: card.id }));
  }
  return null;
}

function takeBuild(state: GameState, playerId: PlayerId, buildId: string, cardId: Card['id']): GameState {
  const build = state.builds.find((candidate) => candidate.id === buildId)!;
  let next = beginMove(state, {
    playerId,
    mode: 'capture',
    reservedHandCardId: cardId,
    targetValue: build.targetValue,
    selectedBuildId: build.id,
  });
  let required = getRequiredMatchingBuildGroup(next) ?? getRequiredExposedGroup(next);
  while (required) {
    next = resolvePendingPublicGroup(next, playerId, required, 'extra-capture');
    required = getRequiredMatchingBuildGroup(next) ?? getRequiredExposedGroup(next);
  }
  return commitPendingMove(next, playerId);
}

interface CandidateMove extends BotDecision {
  capturedGain: number;
  floorGain: number;
  buildGain: number;
  handCardValue: number;
}

function candidate(
  before: GameState,
  after: GameState,
  playerId: PlayerId,
  strategy: string,
  handCardValue: number,
): CandidateMove {
  return {
    state: after,
    strategy,
    capturedGain: after.players[playerId].captured.length - before.players[playerId].captured.length,
    floorGain: before.floor.length - after.floor.length,
    buildGain: after.builds.reduce((sum, build) => sum + build.orderedCards.length, 0) -
      before.builds.reduce((sum, build) => sum + build.orderedCards.length, 0),
    handCardValue,
  };
}

function legalCandidates(state: GameState, playerId: PlayerId): CandidateMove[] {
  const player = state.players[playerId];
  const moves: CandidateMove[] = [];
  const seen = new Set<string>();
  const add = (next: GameState, strategy: string, value: number) => {
    const key = JSON.stringify({
      hand: next.players[playerId].hand.map((card) => card.id),
      floor: next.floor.map((card) => card.id),
      builds: next.builds.map((build) => build.id),
      captured: next.players[playerId].captured.map((card) => card.id),
    });
    if (!seen.has(key)) {
      seen.add(key);
      moves.push(candidate(state, next, playerId, strategy, value));
    }
  };

  const ownBuild = state.builds.find((build) => build.ownerPlayerId === playerId);
  if (ownBuild) {
    const matching = player.hand.find((card) => card.value === ownBuild.targetValue);
    if (matching) add(takeBuild(state, playerId, ownBuild.id, matching.id), 'Claim the Build', matching.value);
  }

  if (state.mode === 'partners-2v2' && state.playerTeams) {
    const teamBuild = state.builds.find((build) => (
      build.ownerPlayerId !== playerId && build.ownerTeamId === state.playerTeams![playerId]
    ));
    if (teamBuild) {
      const matching = player.hand.filter((card) => card.value === teamBuild.targetValue);
      if (matching.length >= 2) {
        try {
          add(applyGameAction(state, {
            type: 'secure-build',
            playerId,
            buildId: teamBuild.id,
            cardId: matching[0].id,
          }), 'Partner Stay', matching[0].value);
        } catch {
          // The partner can only assume responsibility through a fully legal Stay.
        }
      }
    }
  }

  for (const card of player.hand) {
    for (const build of state.builds.filter((candidateBuild) => candidateBuild.targetValue === card.value)) {
      try {
        add(takeBuild(state, playerId, build.id, card.id), 'Break the Build', card.value);
      } catch {
        // The rules engine remains the authority for every generated option.
      }
    }

    const group = firstPublicCapture(state, playerId, card.value);
    if (group) {
      try {
        add(applyGameAction(state, {
          type: 'capture',
          playerId,
          playedCardId: card.id,
          groups: [{ type: 'cards', cards: group }],
        }), card.value <= 4 ? 'Low Sweep' : 'Table Sweep', card.value);
      } catch {
        // Ignore candidates rejected by the authoritative rules engine.
      }
    }

    const controlledBuild = state.builds.find((build) => (
      build.ownerPlayerId === playerId || (
        state.mode === 'partners-2v2' && build.ownerTeamId === state.playerTeams?.[playerId]
      )
    ));
    if (controlledBuild && card.value < controlledBuild.targetValue) {
      const continuation = findSubset(state.floor, controlledBuild.targetValue - card.value);
      const retainsTarget = player.hand.some((held) => held.id !== card.id && held.value === controlledBuild.targetValue);
      if (continuation?.length && retainsTarget) {
        try {
          add(applyGameAction(state, {
            type: 'continue-build',
            playerId,
            buildId: controlledBuild.id,
            cards: [
              { source: 'hand', cardId: card.id },
              ...continuation.map((floorCard) => ({ source: 'floor' as const, cardId: floorCard.id })),
            ],
          }), 'Strengthen the Team Build', card.value);
        } catch {
          // Another public-card obligation can make this continuation unavailable.
        }
      }
    }

    const matchingLoose = state.floor.find((floorCard) => floorCard.value === card.value);
    const retainsSame = player.hand.some((held) => held.id !== card.id && held.value === card.value);
    if (matchingLoose && retainsSame) {
      try {
        add(applyGameAction(state, {
          type: 'stay-build', playerId, playedCardId: card.id, floorCardIds: [matchingLoose.id],
        }), 'Lock the Value', card.value);
      } catch {
        // A player or team may already have a build that must remain the focus.
      }
    }

    const buildTargets = [...new Set(player.hand
      .filter((held) => held.id !== card.id && held.value > card.value)
      .map((held) => held.value))];
    for (const targetValue of buildTargets) {
      const floorCards = findSubset(state.floor, targetValue - card.value);
      if (!floorCards?.length) continue;
      try {
        add(applyGameAction(state, {
          type: 'create-build',
          playerId,
          playedCardId: card.id,
          floorCardIds: floorCards.map((floorCard) => floorCard.id),
          targetValue,
        }), targetValue <= 6 ? 'Low Build Gambit' : 'Build Pressure', card.value);
      } catch {
        // Existing ownership and public-card rules may reject an otherwise valid sum.
      }
    }

    try {
      add(
        applyGameAction(state, { type: 'drop', playerId, cardId: card.id }),
        card.value <= 3 ? 'Low Card Gambit' : 'Quiet Drop',
        card.value,
      );
    } catch {
      // Owning a build can make a drop illegal in Round 1.
    }
  }

  return moves;
}

function immediateScore(move: CandidateMove): number {
  return move.capturedGain * 100 + move.floorGain * 12 + move.buildGain * 42 - move.handCardValue;
}

function publicTableRisk(state: GameState): number {
  const reachable = new Set<number>();
  const cards = state.floor.slice(0, 12);
  for (let mask = 1; mask < 1 << cards.length; mask += 1) {
    let sum = 0;
    for (let index = 0; index < cards.length; index += 1) {
      if ((mask & (1 << index)) !== 0) sum += cards[index].value;
    }
    if (sum <= 10) reachable.add(sum);
  }
  return reachable.size + state.floor.length * 0.5;
}

export function chooseAutomaticTurn(
  state: GameState,
  playerId: PlayerId,
  difficulty: BotDifficulty = 'easy',
): BotDecision {
  if (state.phase === 'complete') return { state, strategy: 'Game Complete' };
  if (state.currentPlayer !== playerId) throw new Error('The automatic player cannot act out of turn.');

  if (state.pendingMove) {
    if (state.pendingMove.playerId !== playerId) throw new Error('Another player owns the pending move.');
    const required = getRequiredMatchingBuildGroup(state) ?? getRequiredExposedGroup(state);
    return {
      state: required
        ? resolvePendingPublicGroup(state, playerId, required, 'extra-capture')
        : commitPendingMove(state, playerId),
      strategy: 'Complete the Play',
    };
  }

  const moves = legalCandidates(state, playerId);
  if (!moves.length) throw new Error('The automatic player has no legal card to play.');
  if (difficulty === 'easy') return moves[0];

  let ranked = moves.map((move) => ({ move, score: immediateScore(move) }));
  if (difficulty === 'hard') {
    ranked = ranked.map(({ move, score }) => ({
      move,
      score: score - publicTableRisk(move.state) * 4,
    }));
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].move;
}

/** Plays one complete legal turn. Easy remains the default for deterministic engine tests. */
export function playAutomaticTurn(
  state: GameState,
  playerId: PlayerId,
  difficulty: BotDifficulty = 'easy',
): GameState {
  return chooseAutomaticTurn(state, playerId, difficulty).state;
}
