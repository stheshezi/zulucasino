import { Card, GameScore, GameState, PlayerId, ScoreBreakdown, TeamId } from './types.js';

function emptyBreakdown(): ScoreBreakdown {
  return { aces: 0, tenOfDiamonds: 0, twoOfSpades: 0, spades: 0, cards: 0, total: 0 };
}

function fixedCardPoints(cards: Card[]): ScoreBreakdown {
  const score = emptyBreakdown();
  score.aces = cards.filter((card) => card.value === 1).length;
  score.tenOfDiamonds = cards.some((card) => card.id === 'diamonds-10') ? 2 : 0;
  score.twoOfSpades = cards.some((card) => card.id === 'spades-2') ? 1 : 0;
  return score;
}

function awardMajorities(
  ids: string[],
  cardsById: Record<string, Card[]>,
  scores: Record<string, ScoreBreakdown>,
): void {
  if (ids.length !== 2) throw new Error('Pack and spade points require two opposing sides.');
  const [first, second] = ids;
  const spades = Object.fromEntries(ids.map((id) => [id, cardsById[id].filter((card) => card.suit === 'spades').length]));
  if (spades[first] === spades[second]) {
    scores[first].spades = 1;
    scores[second].spades = 1;
  } else {
    scores[spades[first] > spades[second] ? first : second].spades = 2;
  }

  if (cardsById[first].length === cardsById[second].length) {
    scores[first].cards = 1;
    scores[second].cards = 1;
  } else {
    scores[cardsById[first].length > cardsById[second].length ? first : second].cards = 2;
  }
}

function total(score: ScoreBreakdown): void {
  score.total = score.aces + score.tenOfDiamonds + score.twoOfSpades + score.spades + score.cards;
}

export function calculateScore(state: GameState): GameScore {
  const playerIds = state.turnOrder;
  const capturedCount = playerIds.reduce((sum, id) => sum + state.players[id].captured.length, 0);
  if (capturedCount !== 40) throw new Error(`Scoring requires 40 captured cards; found ${capturedCount}.`);

  const playerScores: Record<PlayerId, ScoreBreakdown> = Object.fromEntries(
    playerIds.map((id) => [id, fixedCardPoints(state.players[id].captured)]),
  );
  const mode = state.mode ?? 'classic-1v1';

  if (mode === 'partners-2v2') {
    if (!state.playerTeams) throw new Error('Partners scoring requires team assignments.');
    const teamIds = [...new Set(Object.values(state.playerTeams))];
    if (teamIds.length !== 2) throw new Error('Partners scoring requires exactly two teams.');
    const cardsByTeam: Record<TeamId, Card[]> = Object.fromEntries(teamIds.map((id) => [id, []]));
    for (const playerId of playerIds) cardsByTeam[state.playerTeams[playerId]].push(...state.players[playerId].captured);
    const teamScores: Record<TeamId, ScoreBreakdown> = Object.fromEntries(
      teamIds.map((id) => [id, fixedCardPoints(cardsByTeam[id])]),
    );
    awardMajorities(teamIds, cardsByTeam, teamScores);
    teamIds.forEach((id) => total(teamScores[id]));
    Object.values(playerScores).forEach(total);
    const winnerTeamId = teamScores[teamIds[0]].total > teamScores[teamIds[1]].total ? teamIds[0] : teamIds[1];
    return {
      players: playerScores,
      teams: teamScores,
      winnerPlayerId: playerIds.find((id) => state.playerTeams![id] === winnerTeamId)!,
      winnerTeamId,
      combinedPoints: teamIds.reduce((sum, id) => sum + teamScores[id].total, 0),
    };
  }

  if (mode === 'classic-1v1') {
    if (playerIds.length !== 2) throw new Error('Classic Duel scoring requires exactly two players.');
    const cardsByPlayer = Object.fromEntries(playerIds.map((id) => [id, state.players[id].captured]));
    awardMajorities(playerIds, cardsByPlayer, playerScores);
  }

  playerIds.forEach((id) => total(playerScores[id]));
  const ordered = [...playerIds].sort((a, b) => playerScores[b].total - playerScores[a].total);
  const totals = ordered.map((id) => playerScores[id].total);
  return {
    players: playerScores,
    winnerPlayerId: ordered[0],
    isDraw: mode !== 'classic-1v1' && new Set(totals).size !== totals.length,
    combinedPoints: playerIds.reduce((sum, id) => sum + playerScores[id].total, 0),
  };
}
