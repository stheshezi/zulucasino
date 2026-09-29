import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/react';
import {
  applyGameAction,
  canStartNextRound,
  BotDifficulty,
  Card,
  CardId,
  CaptureCardRef,
  commitPendingMove,
  createInitialGame,
  GameMode,
  GameState,
  getCapturePlan,
  getRequiredExposedGroup,
  getRequiredMatchingBuildGroup,
  getLooseBuildPlan,
  getLoosePlacementOptions,
  orderBuildGroup,
  getRoundLabel,
  chooseAutomaticTurn,
  PlayerId,
  resolvePendingPublicGroup,
  startRoundTwo,
  validateGameState,
} from './game';
import { PlayerArea } from './components/PlayerArea';
import { PlayingCard } from './components/PlayingCard';
import { gameSounds } from './audio';
import {
  GamePreferences,
  loadGamePreferences,
  saveGamePreferences,
} from './gamePreferences';

const VIEWER_PLAYER_ID: PlayerId = 'player-1';
const AUTO_PLAYER_ID: PlayerId = 'player-2';
const SAVED_GAME_KEY = 'zulu-casino.active-game.v1';
const SAVED_HISTORY_KEY = 'zulu-casino.game-history.v1';
const BOT_DIFFICULTY_KEY = 'zulu-casino.bot-difficulty.v1';
const MODE_LABELS: Record<GameMode, string> = {
  'classic-1v1': 'Classic Duel',
  'three-hand-rush': '3-Hand Rush',
  'three-hand-qualifier': 'Qualifier Rotation',
  'partners-2v2': 'Partners 2v2',
};

function loadBotDifficulty(): BotDifficulty {
  if (typeof window === 'undefined') return 'easy';
  const saved = window.localStorage.getItem(BOT_DIFFICULTY_KEY);
  return saved === 'medium' || saved === 'hard' ? saved : 'easy';
}

function loadActiveGame(): GameState {
  if (typeof window === 'undefined') return createInitialGame();

  try {
    const saved = window.localStorage.getItem(SAVED_GAME_KEY);
    if (!saved) return createInitialGame();
    const game = JSON.parse(saved) as GameState;
    return validateGameState(game).valid ? game : createInitialGame();
  } catch {
    return createInitialGame();
  }
}

function loadGameHistory(): GameState[] {
  if (typeof window === 'undefined') return [];

  try {
    const saved = window.localStorage.getItem(SAVED_HISTORY_KEY);
    if (!saved) return [];
    const history = JSON.parse(saved) as GameState[];
    return history.filter((state) => validateGameState(state).valid).slice(-80);
  } catch {
    return [];
  }
}

interface OpponentMovePreview {
  card: Card;
  choice: 'drop' | 'take';
  decisionShown: boolean;
  floorCardIds: CardId[];
  buildId: string | null;
  exposedInventory: boolean;
  exposedCardTaken: Card | null;
  revealedCard: Card | null;
}

interface PartnerStayOffer {
  actorPlayerId: PlayerId;
  buildId: string;
  cardId: CardId;
  resolvedTakeState: GameState;
}

interface QualifierDuelState {
  spectating: boolean;
}

interface TableAnimationState {
  phase: 'idle' | 'shuffle' | 'deal';
  visibleHandCounts: Record<PlayerId, number>;
  destinationPlayerId: PlayerId | null;
  cardSequence: number;
}

export default function App() {
  const [game, setGame] = useState<GameState>(loadActiveGame);
  const [message, setMessage] = useState('Your active table is ready.');
  const [selectedHandId, setSelectedHandId] = useState<CardId | null>(null);
  const [selectedFloorIds, setSelectedFloorIds] = useState<CardId[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const [exposedSelected, setExposedSelected] = useState(false);
  const [activePublicPlayerId, setActivePublicPlayerId] = useState<PlayerId | null>(null);
  const [draggedHandId, setDraggedHandId] = useState<CardId | null>(null);
  const [draggedFloorId, setDraggedFloorId] = useState<CardId | null>(null);
  const [draggedExposedId, setDraggedExposedId] = useState<CardId | null>(null);
  const [placementActive, setPlacementActive] = useState(false);
  const [opponentMovePreview, setOpponentMovePreview] = useState<OpponentMovePreview | null>(null);
  const [partnerStayOffer, setPartnerStayOffer] = useState<PartnerStayOffer | null>(null);
  const [qualifierDuel, setQualifierDuel] = useState<QualifierDuelState | null>(null);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>(loadBotDifficulty);
  const [preferences, setPreferences] = useState<GamePreferences>(loadGamePreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tableAnimation, setTableAnimation] = useState<TableAnimationState>({
    phase: 'idle',
    visibleHandCounts: {},
    destinationPlayerId: null,
    cardSequence: 0,
  });
  const animationTimersRef = useRef<number[]>([]);
  const previousPhaseRef = useRef(game.phase);
  const historyRef = useRef<GameState[]>(loadGameHistory());
  const restoringHistoryRef = useRef(false);
  const [historyDepth, setHistoryDepth] = useState(historyRef.current.length);
  const validation = useMemo(() => validateGameState(game), [game]);
  const viewer = game.players[VIEWER_PLAYER_ID];
  const publicPlayerIds = game.turnOrder.filter((id) => id !== VIEWER_PLAYER_ID);
  const defaultOpponentId = publicPlayerIds.find((id) => (
    (game.mode ?? 'classic-1v1') !== 'partners-2v2' || game.playerTeams?.[id] !== game.playerTeams?.[VIEWER_PLAYER_ID]
  )) ?? publicPlayerIds[0] ?? AUTO_PLAYER_ID;
  const activePublicId = activePublicPlayerId && game.players[activePublicPlayerId]
    ? activePublicPlayerId
    : defaultOpponentId;
  const opponent = game.players[activePublicId];
  const viewerControlsBuild = (build: GameState['builds'][number]) => (
    build.ownerPlayerId === VIEWER_PLAYER_ID || (
      game.mode === 'partners-2v2' &&
      build.ownerTeamId === game.playerTeams?.[VIEWER_PLAYER_ID]
    )
  );
  const buildTablePlayerId = (build: GameState['builds'][number]) => build.tablePlayerId ?? build.ownerPlayerId;
  const selectedHand = viewer.hand.find((card) => card.id === selectedHandId) ?? null;
  const isAnimating = tableAnimation.phase !== 'idle';

  useEffect(() => {
    gameSounds.setEnabled(preferences.soundEffects);
    gameSounds.preload();
    saveGamePreferences(preferences);
  }, [preferences]);

  useEffect(() => () => {
    animationTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (previousPhaseRef.current !== 'complete' && game.phase === 'complete' && game.score) {
      const viewerWon = game.score.winnerPlayerId === VIEWER_PLAYER_ID || (
        game.score.winnerTeamId && game.score.winnerTeamId === game.playerTeams?.[VIEWER_PLAYER_ID]
      );
      gameSounds.play(viewerWon ? 'win' : 'lose', 0.65);
    }
    previousPhaseRef.current = game.phase;
  }, [game.phase, game.playerTeams, game.score]);

  function clearAnimationTimers() {
    animationTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    animationTimersRef.current = [];
  }

  function beginRoundPresentation(next: GameState) {
    clearAnimationTimers();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shuffleEnabled = next.round === 1 && preferences.shuffleAnimation && !reduceMotion;
    const dealEnabled = preferences.dealAnimation && !reduceMotion;
    const emptyCounts = Object.fromEntries(next.turnOrder.map((id) => [id, 0]));
    const fullCounts = Object.fromEntries(next.turnOrder.map((id) => [id, next.players[id].hand.length]));
    const dealOrder = next.round === 2
      ? [...next.turnOrder.slice(next.turnOrder.indexOf(next.currentPlayer)), ...next.turnOrder.slice(0, next.turnOrder.indexOf(next.currentPlayer))]
      : next.turnOrder;
    const destinations: PlayerId[] = [];
    const largestHand = Math.max(...dealOrder.map((id) => next.players[id].hand.length));
    for (let cardIndex = 0; cardIndex < largestHand; cardIndex += 1) {
      dealOrder.forEach((id) => {
        if (next.players[id].hand[cardIndex]) destinations.push(id);
      });
    }

    gameSounds.play('game-start', 0.42);
    if (next.round === 1 && preferences.soundEffects) gameSounds.play('shuffle', 0.48);

    const startDeal = () => {
      if (!dealEnabled) {
        setTableAnimation({ phase: 'idle', visibleHandCounts: fullCounts, destinationPlayerId: null, cardSequence: 0 });
        return;
      }
      setMessage('Dealing one card at a time...');
      setTableAnimation({ phase: 'deal', visibleHandCounts: emptyCounts, destinationPlayerId: destinations[0] ?? null, cardSequence: 0 });
      destinations.forEach((playerId, index) => {
        const timer = window.setTimeout(() => {
          gameSounds.play('card-deal', 0.28);
          setTableAnimation((current) => ({
            phase: 'deal',
            visibleHandCounts: {
              ...current.visibleHandCounts,
              [playerId]: (current.visibleHandCounts[playerId] ?? 0) + 1,
            },
            destinationPlayerId: destinations[index + 1] ?? null,
            cardSequence: index + 1,
          }));
          if (index === destinations.length - 1) {
            const finishTimer = window.setTimeout(() => {
              gameSounds.play('card-flip', 0.32);
              setTableAnimation({ phase: 'idle', visibleHandCounts: fullCounts, destinationPlayerId: null, cardSequence: index + 1 });
              setMessage(`${next.players[next.currentPlayer].name} starts.`);
            }, 280);
            animationTimersRef.current.push(finishTimer);
          }
        }, (index + 1) * 300);
        animationTimersRef.current.push(timer);
      });
    };

    if (shuffleEnabled) {
      setTableAnimation({ phase: 'shuffle', visibleHandCounts: emptyCounts, destinationPlayerId: null, cardSequence: 0 });
      const timer = window.setTimeout(startDeal, 1250);
      animationTimersRef.current.push(timer);
    } else {
      startDeal();
    }
  }

  function updatePreference(key: keyof GamePreferences) {
    setPreferences((current) => ({ ...current, [key]: !current[key] }));
  }

  useEffect(() => {
    window.localStorage.setItem(SAVED_GAME_KEY, JSON.stringify(game));
  }, [game]);

  useEffect(() => {
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }

    const history = historyRef.current;
    const last = history.at(-1);
    if (!last || last.revision !== game.revision) {
      historyRef.current = [...history, game].slice(-80);
      window.localStorage.setItem(SAVED_HISTORY_KEY, JSON.stringify(historyRef.current));
      setHistoryDepth(historyRef.current.length);
    }
  }, [game]);

  function clearSelection() {
    setSelectedHandId(null);
    setSelectedFloorIds([]);
    setSelectedBuildId(null);
    setExposedSelected(false);
    setActivePublicPlayerId(null);
    setDraggedHandId(null);
    setDraggedFloorId(null);
    setDraggedExposedId(null);
    setPlacementActive(false);
  }

  function transition(action: (current: GameState) => GameState, successMessage: string) {
    setGame((current) => {
      try {
        const next = action(current);
        const capturedBefore = Object.values(current.players).reduce((total, player) => total + player.captured.length, 0);
        const capturedAfter = Object.values(next.players).reduce((total, player) => total + player.captured.length, 0);
        gameSounds.play(capturedAfter > capturedBefore ? 'take' : 'card-play', capturedAfter > capturedBefore ? 0.48 : 0.38);
        setMessage(successMessage);
        return next;
      } catch (error) {
        gameSounds.play('invalid-move', 0.34);
        setMessage(error instanceof Error ? error.message : 'The action could not be completed.');
        return current;
      }
    });
  }

  useEffect(() => {
    if (game.phase === 'complete' || partnerStayOffer || isAnimating) return;
    if (canStartNextRound(game)) {
      const timer = window.setTimeout(() => {
        setGame((current) => {
          try {
            const next = startRoundTwo(current);
            setMessage('Round 2: shuffling is skipped; dealing the unchanged remaining deck.');
            beginRoundPresentation(next);
            return next;
          } catch (error) {
            gameSounds.play('invalid-move', 0.34);
            setMessage(error instanceof Error ? error.message : 'Round 2 could not begin.');
            return current;
          }
        });
        clearSelection();
      }, 700);
      return () => window.clearTimeout(timer);
    }
    if (game.currentPlayer === VIEWER_PLAYER_ID && !qualifierDuel?.spectating) return;
    const automaticPlayerId = game.currentPlayer;
    const automaticPlayer = game.players[automaticPlayerId];
    setMessage(`${automaticPlayer.name} is choosing a legal move...`);
    const timers: number[] = [];
    const timer = window.setTimeout(() => {
      try {
        const expectedRevision = game.revision;
        const decision = chooseAutomaticTurn(game, automaticPlayerId, botDifficulty);
        const next = decision.state;
        const captured = next.players[automaticPlayerId].captured.length > game.players[automaticPlayerId].captured.length;
        const playedCard = game.players[automaticPlayerId].hand.find(
          (card) => !next.players[automaticPlayerId].hand.some((remaining) => remaining.id === card.id),
        );
        if (!playedCard) throw new Error('Player 2 did not choose a hand card.');
        const floorCardIds = game.floor
          .filter((card) => !next.floor.some((remaining) => remaining.id === card.id))
          .map((card) => card.id);
        const removedBuild = game.builds.find((build) => !next.builds.some((remaining) => remaining.id === build.id));
        const oldExposed = viewer.captured.at(-1);
        const exposedInventory = Boolean(oldExposed && !next.players[VIEWER_PLAYER_ID].captured.some((card) => card.id === oldExposed.id));
        const revealedCard = next.players[VIEWER_PLAYER_ID].captured.at(-1) ?? null;

        const preview: OpponentMovePreview = {
          card: playedCard,
          choice: captured ? 'take' : 'drop',
          decisionShown: false,
          floorCardIds,
          buildId: removedBuild?.id ?? null,
          exposedInventory,
          exposedCardTaken: exposedInventory ? oldExposed ?? null : null,
          revealedCard,
        };
        setOpponentMovePreview(preview);
        gameSounds.play('card-play', 0.38);
        setMessage(`${automaticPlayer.name} considers ${decision.strategy}...`);

        timers.push(window.setTimeout(() => {
          setOpponentMovePreview({ ...preview, decisionShown: true });
          gameSounds.play(captured ? 'take' : 'card-play', captured ? 0.48 : 0.32);
          setMessage(exposedInventory && oldExposed
            ? `${automaticPlayer.name} declares Take ${playedCard.value} and takes your exposed ${oldExposed.value}.`
            : `${automaticPlayer.name} declares ${captured ? 'Take' : 'Drop'}.`);
        }, 280));

        timers.push(window.setTimeout(() => {
          const viewerMayCallStay = Boolean(
            game.mode === 'partners-2v2' && removedBuild &&
            game.playerTeams?.[automaticPlayerId] === game.playerTeams?.[VIEWER_PLAYER_ID] &&
            viewer.hand.some((card) => card.value === removedBuild.targetValue)
          );
          if (viewerMayCallStay && removedBuild) {
            setOpponentMovePreview(null);
            setPartnerStayOffer({
              actorPlayerId: automaticPlayerId,
              buildId: removedBuild.id,
              cardId: playedCard.id,
              resolvedTakeState: next,
            });
            setMessage(`${automaticPlayer.name} declared Take ${removedBuild.targetValue}. Call Stay or let the take finish.`);
            return;
          }
          setGame((current) => current.revision === expectedRevision ? next : current);
          setOpponentMovePreview(null);
          if (exposedInventory && revealedCard) gameSounds.play('card-flip', 0.35);
          setMessage(exposedInventory && oldExposed
            ? `${automaticPlayer.name} took your exposed ${oldExposed.value}. ${revealedCard ? `${revealedCard.value} is now exposed.` : 'Your inventory is now empty.'}`
            : decision.strategy === 'Partner Stay'
              ? `${automaticPlayer.name} declared Stay and assumed responsibility for the team build.`
              : captured ? `${automaticPlayer.name} completed the take.` : `${automaticPlayer.name} completed its move.`);
          clearSelection();
        }, captured ? 850 : 550));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Player 2 could not complete its move.');
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      timers.forEach((scheduled) => window.clearTimeout(scheduled));
    };
  }, [botDifficulty, game.currentPlayer, game.phase, game.revision, partnerStayOffer, qualifierDuel?.spectating, isAnimating]);

  function handleDifficultyChange(difficulty: BotDifficulty) {
    window.localStorage.setItem(BOT_DIFFICULTY_KEY, difficulty);
    setBotDifficulty(difficulty);
    setMessage(`Player 2 learning level set to ${difficulty}.`);
  }

  function selectedPublicRefs(): CaptureCardRef[] {
    const refs: CaptureCardRef[] = selectedFloorIds.map((cardId) => ({ source: 'floor', cardId }));
    const exposed = opponent.captured.at(-1);
    if (exposedSelected && exposed) refs.unshift({ source: 'exposed', playerId: opponent.id, cardId: exposed.id });
    return refs;
  }

  function requireSelectedHand() {
    if (!selectedHand) throw new Error('Select one card from your hand first.');
    return selectedHand;
  }

  function handleDrop() {
    const card = requireSelectedHand();
    handleDropToFloor(card.id);
  }

  function handleDropToFloor(cardId: CardId) {
    const card = viewer.hand.find((candidate) => candidate.id === cardId);
    if (!card) {
      setMessage('Select one card from your hand first.');
      return;
    }
    const responsibleBuild = game.builds.find((build) => build.ownerPlayerId === VIEWER_PLAYER_ID);
    if ((game.mode ?? 'classic-1v1') === 'classic-1v1' && game.round === 1 && responsibleBuild && card.value !== responsibleBuild.targetValue) {
      const needed = responsibleBuild.targetValue - card.value;
      const matchingLoose = game.floor.find((floorCard) => floorCard.value === needed);
      const matchingHand = viewer.hand.find((handCard) => handCard.value === responsibleBuild.targetValue);
      const choices = [
        matchingLoose ? `select loose ${matchingLoose.value} with this ${card.value} to Continue ${responsibleBuild.targetValue}` : null,
        matchingHand ? `use your hand ${matchingHand.value} to Take the build` : null,
      ].filter(Boolean).join(', or ');
      setMessage(`You are responsible for Build ${responsibleBuild.targetValue}, so ${card.value} cannot be dropped. ${choices || 'Resolve the build first.'}`);
      return;
    }
    transition(
      (current) => applyGameAction(current, { type: 'drop', playerId: VIEWER_PLAYER_ID, cardId: card.id }),
      `You dropped ${card.value} to the floor.`,
    );
    clearSelection();
  }

  function handleBeginCapture() {
    const card = requireSelectedHand();
    const refs = selectedPublicRefs();
    const ownBuild = game.builds.find(viewerControlsBuild);
    const forcedOwnBuildId = ownBuild && card.value === ownBuild.targetValue &&
      !viewer.hand.some((candidate) => candidate.id !== card.id && candidate.value === ownBuild.targetValue)
      ? ownBuild.id
      : null;
    const buildToTakeId = selectedBuildId ?? forcedOwnBuildId;
    transition((current) => {
      const refsById = new Map(refs.map((ref) => [ref.cardId, ref]));
      const prioritizedRefs = [
        ...refs.filter((ref) => ref.source === 'floor' && current.floor.find(
          (floorCard) => floorCard.id === ref.cardId && floorCard.value === card.value,
        )),
        ...refs.filter((ref) => !(ref.source === 'floor' && current.floor.find(
          (floorCard) => floorCard.id === ref.cardId && floorCard.value === card.value,
        ))),
      ];
      const selectedCards = prioritizedRefs.map((ref) => ref.source === 'floor'
        ? current.floor.find((candidate) => candidate.id === ref.cardId)!
        : current.players[ref.playerId].captured.at(-1)!);
      const plan = getCapturePlan(selectedCards, card.value);
      if (!plan && refs.length) throw new Error(`The selected public cards cannot be grouped into ${card.value}s.`);
      return applyGameAction(current, {
        type: 'capture',
        playerId: VIEWER_PLAYER_ID,
        playedCardId: card.id,
        groups: [
          ...(buildToTakeId ? [{ type: 'build' as const, buildId: buildToTakeId }] : []),
          ...(plan?.groups ?? []).map((group) => ({
            type: 'cards' as const,
            cards: group.map((cardId) => refsById.get(cardId)!),
          })),
        ],
      });
    }, buildToTakeId
      ? `Build ${card.value} taken. Every matching exposed-top game was taken first.`
      : `All selected ${card.value}-groups taken.`);
    clearSelection();
  }

  function handleDirectMatches() {
    const card = requireSelectedHand();
    const matchingFloorCards = selectedLooseCards.filter((floorCard) => floorCard.value === card.value);
    if (!matchingFloorCards.length) {
      setMessage(`Select a loose ${card.value} to take it directly.`);
      return;
    }
    transition((current) => applyGameAction(current, {
      type: 'capture',
      playerId: VIEWER_PLAYER_ID,
      playedCardId: card.id,
      groups: matchingFloorCards.map((floorCard) => ({
        type: 'cards' as const,
        cards: [{ source: 'floor' as const, cardId: floorCard.id }],
      })),
    }), `You took the matching ${card.value}${matchingFloorCards.length > 1 ? 's' : ''}.`);
    clearSelection();
  }

  function handleBuildFromLoose() {
    const card = requireSelectedHand();
    const refs = selectedPublicRefs();
    transition((current) => {
      const publicCards = refs.map((ref) => {
        if (ref.source === 'floor') {
          const loose = current.floor.find((candidate) => candidate.id === ref.cardId);
          if (!loose) throw new Error('That loose card is no longer on the floor.');
          return loose;
        }
        const exposed = current.players[ref.playerId].captured.at(-1);
        if (!exposed || exposed.id !== ref.cardId) throw new Error('That card is no longer exposed.');
        return exposed;
      });
      if (!publicCards.length) throw new Error('Select the public cards for the build.');
      const plan = getLooseBuildPlan(card, publicCards, current.players[VIEWER_PLAYER_ID].hand);
      if (!plan) throw new Error('Those selected cards do not form complete groups for a supported build.');
      const refsById = new Map(refs.map((ref) => [ref.cardId, ref]));
      return applyGameAction(current, {
        type: 'create-build',
        playerId: VIEWER_PLAYER_ID,
        playedCardId: card.id,
        floorCardIds: plan.primaryFloorCardIds,
        publicCards: plan.primaryFloorCardIds.map((cardId) => refsById.get(cardId)!),
        additionalPublicGroups: plan.additionalFloorGroups.map((group) => (
          group.map((cardId) => refsById.get(cardId)!)
        )),
        targetValue: plan.targetValue,
      });
    }, `Build ${getLooseBuildPlan(card, selectedBuildPublicCards, viewer.hand)?.targetValue ?? ''} created.`);
    clearSelection();
  }

  function handleStay() {
    const card = requireSelectedHand();
    if (selectedFloorIds.length === 0) {
      setMessage('Stay requires a loose group matching the played card.');
      return;
    }
    transition(
      (current) => applyGameAction(current, {
        type: 'stay-build',
        playerId: VIEWER_PLAYER_ID,
        playedCardId: card.id,
        floorCardIds: selectedFloorIds,
      }),
      `Stay ${card.value} declared.`,
    );
    clearSelection();
  }

  function handleStackLoose(sourceCardId: CardId, targetCardId: CardId) {
    if (sourceCardId === targetCardId) return;
    const groupedIds = [
      ...selectedFloorIds.filter((id) => id !== sourceCardId && id !== targetCardId),
      targetCardId,
      sourceCardId,
    ];
    const groupedCards = groupedIds
      .map((id) => game.floor.find((card) => card.id === id))
      .filter((card): card is Card => Boolean(card));
    const total = groupedCards.reduce((sum, card) => sum + card.value, 0);
    setSelectedFloorIds(groupedIds);
    setDraggedFloorId(null);
    setMessage(`Loose group ${orderBuildGroup(groupedCards).map((card) => card.value).join(' + ')} = ${total} staged. Select a matching hand card.`);
  }

  function handleBuildAction(
    mode: 'continue-build' | 'manipulate-build' | 'secure-build',
    buildIdOverride?: string,
  ) {
    const card = requireSelectedHand();
    const refs = selectedPublicRefs();
    const activeBuildId = buildIdOverride ?? selectedBuildId;
    transition((current) => {
      if (!activeBuildId) throw new Error('Select a build first.');
      if (mode === 'secure-build') {
        return applyGameAction(current, {
          type: mode,
          playerId: VIEWER_PLAYER_ID,
          buildId: activeBuildId,
          cardId: card.id,
          publicGroups: refs.length ? [refs] : undefined,
        });
      }
      const cards = [
        { source: 'hand' as const, cardId: card.id },
        ...refs,
      ];
      if (mode === 'continue-build') {
        const build = current.builds.find((candidate) => candidate.id === activeBuildId);
        if (!build) throw new Error('The selected build no longer exists.');
        const publicCards = refs.map((ref) => ref.source === 'floor'
          ? current.floor.find((candidate) => candidate.id === ref.cardId)!
          : current.players[ref.playerId].captured.at(-1)!);
        const plan = getLooseBuildPlan(card, publicCards, current.players[VIEWER_PLAYER_ID].hand);
        if (!plan || plan.targetValue !== build.targetValue) {
          throw new Error(`The selected public cards do not form complete groups for Build ${build.targetValue}.`);
        }
        const refsById = new Map(refs.map((ref) => [ref.cardId, ref]));
        return applyGameAction(current, {
          type: mode,
          playerId: VIEWER_PLAYER_ID,
          buildId: activeBuildId,
          cards: [
            { source: 'hand', cardId: card.id },
            ...plan.primaryFloorCardIds.map((cardId) => refsById.get(cardId)!),
          ],
          additionalPublicGroups: plan.additionalFloorGroups.map((group) => (
            group.map((cardId) => refsById.get(cardId)!)
          )),
        });
      }
      const build = current.builds.find((candidate) => candidate.id === activeBuildId);
      if (!build) throw new Error('The selected build no longer exists.');
      const publicValue = refs.reduce((sum, ref) => {
        const publicCard = ref.source === 'floor'
          ? current.floor.find((candidate) => candidate.id === ref.cardId)
          : current.players[ref.playerId].captured.at(-1);
        return sum + (publicCard?.value ?? 0);
      }, 0);
      const inferredTarget = build.targetValue + card.value + publicValue;
      if (inferredTarget > 10) throw new Error('This raised build would be higher than 10.');
      return applyGameAction(current, {
        type: mode,
        playerId: VIEWER_PLAYER_ID,
        buildId: activeBuildId,
        cards,
        newTargetValue: inferredTarget as GameState['builds'][number]['targetValue'],
      });
    }, mode === 'secure-build' ? `Stay ${card.value} completed.` : `${mode.replaceAll('-', ' ')} completed.`);
    clearSelection();
  }

  function handleContinueBuildWithExposed(handCardId: CardId) {
    const handCard = viewer.hand.find((card) => card.id === handCardId);
    const exposed = opponent.captured.at(-1);
    const ownBuild = game.builds.find(viewerControlsBuild);
    if (!handCard || !exposed || !ownBuild) {
      setMessage('Continuing requires your build, one hand card, and the opponent exposed top.');
      return;
    }
    if (handCard.value + exposed.value !== ownBuild.targetValue) {
      setMessage(`${handCard.value} + exposed ${exposed.value} does not equal Build ${ownBuild.targetValue}.`);
      return;
    }
    transition((current) => applyGameAction(current, {
      type: 'continue-build',
      playerId: VIEWER_PLAYER_ID,
      buildId: ownBuild.id,
      cards: [
        { source: 'hand', cardId: handCard.id },
        { source: 'exposed', playerId: opponent.id, cardId: exposed.id },
      ],
    }), `${exposed.value} + ${handCard.value} continued and secured Build ${ownBuild.targetValue}.`);
    clearSelection();
  }

  function handleDropOnExposed(handCardId: CardId) {
    const handCard = viewer.hand.find((card) => card.id === handCardId);
    const exposed = opponent.captured.at(-1);
    const ownBuild = game.builds.find(viewerControlsBuild);
    const mayStay = Boolean(
      handCard && exposed && ownBuild &&
      handCard.value === ownBuild.targetValue &&
      exposed.value === ownBuild.targetValue &&
      viewer.hand.some((card) => card.id !== handCard.id && card.value === ownBuild.targetValue)
    );
    if (!mayStay) {
      handleContinueBuildWithExposed(handCardId);
      return;
    }
    setSelectedHandId(handCardId);
    setSelectedBuildId(ownBuild!.id);
    setExposedSelected(true);
    setDraggedHandId(null);
    setMessage(`Exposed ${exposed!.value} selected. Choose Stay ${ownBuild!.targetValue} or Take.`);
  }

  function handleStageExposedOnBuild(buildId: string) {
    const exposed = opponent.captured.at(-1);
    const build = game.builds.find((candidate) => candidate.id === buildId);
    if (!exposed || !build) return;
    if (!viewerControlsBuild(build) || exposed.value > build.targetValue) {
      setMessage('That exposed card cannot be staged on this build.');
      return;
    }
    setSelectedBuildId(build.id);
    setExposedSelected(true);
    setDraggedExposedId(null);
    setMessage(`Exposed ${exposed.value} moved onto Build ${build.targetValue}. Complete its group, then Continue or Stay.`);
  }

  function handleTakeBuild(handCardId: CardId, buildId: string) {
    const handCard = viewer.hand.find((card) => card.id === handCardId);
    const build = game.builds.find((candidate) => candidate.id === buildId);
    if (!handCard || !build) {
      setMessage('Select a matching hand card and build first.');
      return;
    }
    if (handCard.value !== build.targetValue) {
      setMessage(`${handCard.value} cannot take Build ${build.targetValue}.`);
      return;
    }
    if (viewerControlsBuild(build) && build.ownerPlayerId !== VIEWER_PLAYER_ID) {
      setMessage(`Your partner is responsible for Build ${build.targetValue}. Continue it or declare Stay to assume responsibility.`);
      return;
    }
    const teammate = game.mode === 'partners-2v2'
      ? game.turnOrder.find((id) => (
          id !== VIEWER_PLAYER_ID && game.playerTeams?.[id] === game.playerTeams?.[VIEWER_PLAYER_ID]
        ))
      : undefined;
    if (
      teammate && botDifficulty !== 'easy' && viewerControlsBuild(build) &&
      game.players[teammate].hand.some((card) => card.value === build.targetValue)
    ) {
      transition((current) => applyGameAction(current, {
        type: 'partner-stay',
        playerId: VIEWER_PLAYER_ID,
        partnerPlayerId: teammate,
        buildId: build.id,
        cardId: handCard.id,
      }), `${game.players[teammate].name} calls Stay ${build.targetValue} and assumes responsibility.`);
      clearSelection();
      return;
    }
    transition((current) => applyGameAction(current, {
      type: 'capture',
      playerId: VIEWER_PLAYER_ID,
      playedCardId: handCard.id,
      groups: [{ type: 'build', buildId: build.id }],
    }), `You took Build ${build.targetValue} with ${handCard.value}.`);
    clearSelection();
  }

  function handleCallPartnerStay() {
    if (!partnerStayOffer) return;
    transition((current) => applyGameAction(current, {
      type: 'partner-stay',
      playerId: partnerStayOffer.actorPlayerId,
      partnerPlayerId: VIEWER_PLAYER_ID,
      buildId: partnerStayOffer.buildId,
      cardId: partnerStayOffer.cardId,
    }), 'You called Stay. The played card remains on the team build and responsibility is now yours.');
    setPartnerStayOffer(null);
    clearSelection();
  }

  function handleAllowPartnerTake() {
    if (!partnerStayOffer) return;
    setGame(partnerStayOffer.resolvedTakeState);
    setPartnerStayOffer(null);
    setMessage('You let your partner complete the take.');
    clearSelection();
  }

  function handleDropOnBuild(handCardId: CardId, buildId: string) {
    const handCard = viewer.hand.find((card) => card.id === handCardId);
    const build = game.builds.find((candidate) => candidate.id === buildId);
    const mayStay = Boolean(
      handCard &&
      build && viewerControlsBuild(build) &&
      handCard.value === build.targetValue &&
      viewer.hand.some((card) => card.id !== handCard.id && card.value === build.targetValue)
    );
    if (!mayStay) {
      handleTakeBuild(handCardId, buildId);
      return;
    }
    setSelectedHandId(handCardId);
    setSelectedBuildId(buildId);
    setDraggedHandId(null);
    setMessage(`Choose Take ${build!.targetValue} or Stay ${build!.targetValue}.`);
  }

  function handlePlaceOnLoose(floorCardId: CardId, handCardId: CardId) {
    const handCard = viewer.hand.find((card) => card.id === handCardId);
    if (!handCard) return;
    const floorCardIds = selectedFloorIds.includes(floorCardId)
      ? selectedFloorIds
      : [...selectedFloorIds, floorCardId];
    const looseCards = floorCardIds
      .map((cardId) => game.floor.find((card) => card.id === cardId))
      .filter((card): card is Card => Boolean(card));
    const ownBuild = game.builds.find(viewerControlsBuild);
    const continuationTotal = handCard.value + looseCards.reduce((sum, card) => sum + card.value, 0);
    if (ownBuild && continuationTotal === ownBuild.targetValue) {
      setSelectedHandId(handCard.id);
      setSelectedFloorIds(floorCardIds);
      setSelectedBuildId(ownBuild.id);
      setPlacementActive(true);
      setDraggedHandId(null);
      setMessage(`${looseCards.map((card) => card.value).join(' + ')} + ${handCard.value} is staged for Build ${ownBuild.targetValue}. Add any other public groups, then Continue.`);
      return;
    }
    const { choices: legalChoices, buildTarget, hasTakeExtension, hasBuildExtension } = getLoosePlacementOptions(
      handCard,
      looseCards,
      viewer.hand,
      game.floor,
    );

    if (legalChoices.length === 1 && !hasTakeExtension && !hasBuildExtension) {
      const choice = legalChoices[0];
      transition((current) => {
        if (choice === 'take') {
          return applyGameAction(current, {
            type: 'capture',
            playerId: VIEWER_PLAYER_ID,
            playedCardId: handCard.id,
            groups: [{
              type: 'cards',
              cards: floorCardIds.map((cardId) => ({ source: 'floor' as const, cardId })),
            }],
          });
        }
        if (choice === 'stay') {
          return applyGameAction(current, {
            type: 'stay-build',
            playerId: VIEWER_PLAYER_ID,
            playedCardId: handCard.id,
            floorCardIds,
          });
        }
        return applyGameAction(current, {
          type: 'create-build',
          playerId: VIEWER_PLAYER_ID,
          playedCardId: handCard.id,
          floorCardIds: getLooseBuildPlan(handCard, looseCards, viewer.hand)!.primaryFloorCardIds,
          additionalFloorGroups: getLooseBuildPlan(handCard, looseCards, viewer.hand)!.additionalFloorGroups,
          targetValue: buildTarget as GameState['builds'][number]['targetValue'],
        });
      }, choice === 'take' ? `You took ${handCard.value}.` : choice === 'stay' ? `Stay ${handCard.value} declared.` : `Build ${buildTarget} created.`);
      clearSelection();
      return;
    }

    setSelectedHandId(handCard.id);
    setSelectedFloorIds(floorCardIds);
    setPlacementActive(true);
    setDraggedHandId(null);
    setMessage(
      legalChoices.length > 1 || hasTakeExtension || hasBuildExtension
        ? `You placed ${handCard.value}. Choose its legal result.`
        : 'That placement has no legal game. Move it to clear floor space to Drop.',
    );
  }

  function handleResolvePublic() {
    const refs = selectedPublicRefs();
    if (!refs.length) {
      setMessage('Select floor cards or the opponent exposed top card first.');
      return;
    }
    const hasPrimary = game.pendingMove?.groups.some((group) => group.purpose === 'primary');
    const purpose = game.pendingMove?.mode === 'capture' && (game.pendingMove.selectedBuildId || hasPrimary)
      ? 'extra-capture'
      : 'primary';
    transition(
      (current) => resolvePendingPublicGroup(current, VIEWER_PLAYER_ID, refs, purpose),
      'Public cards resolved. Newly exposed top card is now live.',
    );
    setSelectedFloorIds([]);
    setExposedSelected(false);
  }

  function handleRequiredTop() {
    const refs = getRequiredMatchingBuildGroup(game) ?? getRequiredExposedGroup(game);
    if (!refs) {
      setMessage('There is no required exposed-top interaction right now.');
      return;
    }
    transition(
      (current) => resolvePendingPublicGroup(current, VIEWER_PLAYER_ID, refs, 'extra-capture'),
      'Required matching public card resolved.',
    );
  }

  function handleCommit() {
    transition(
      (current) => commitPendingMove(current, VIEWER_PLAYER_ID),
      'Hand card committed and move finalized.',
    );
    clearSelection();
  }

  function handleNewGame(mode: GameMode = game.mode ?? 'classic-1v1') {
    if (isAnimating) return;
    const next = createInitialGame({ mode });
    historyRef.current = [next];
    restoringHistoryRef.current = true;
    setHistoryDepth(1);
    window.localStorage.setItem(SAVED_HISTORY_KEY, JSON.stringify(historyRef.current));
    setGame(next);
    setPartnerStayOffer(null);
    setQualifierDuel(null);
    clearSelection();
    setSettingsOpen(false);
    setMessage('Shuffling the deck...');
    beginRoundPresentation(next);
  }

  function handleQualifierAdvance() {
    if (game.mode !== 'three-hand-qualifier' || !game.score) return;
    if (game.score.isDraw) {
      handleNewGame('three-hand-qualifier');
      setMessage('The draw resets all three players into a fresh qualifier deal.');
      return;
    }
    const ranking = [...game.turnOrder].sort(
      (first, second) => game.score!.players[second].total - game.score!.players[first].total,
    );
    const [winnerId, runnerUpId] = ranking;
    const viewerQualified = winnerId === VIEWER_PLAYER_ID || runnerUpId === VIEWER_PLAYER_ID;
    const firstDuelist = viewerQualified ? VIEWER_PLAYER_ID : winnerId;
    const secondDuelist = firstDuelist === winnerId ? runnerUpId : winnerId;
    const runnerSeat = runnerUpId === firstDuelist ? 'player-1' : 'player-2';
    const next = createInitialGame({ mode: 'classic-1v1', startingPlayer: runnerSeat });
    next.players['player-1'].name = game.players[firstDuelist].name;
    next.players['player-2'].name = game.players[secondDuelist].name;
    historyRef.current = [next];
    restoringHistoryRef.current = true;
    setHistoryDepth(1);
    window.localStorage.setItem(SAVED_HISTORY_KEY, JSON.stringify(historyRef.current));
    setGame(next);
    setQualifierDuel({ spectating: !viewerQualified });
    clearSelection();
    setMessage(`${game.players[runnerUpId].name} starts the qualifying 1v1. ${game.players[ranking[2]].name} waits.`);
  }

  function handleUndoTurn() {
    const history = historyRef.current;
    let restoreIndex = -1;
    for (let index = history.length - 2; index >= 0; index -= 1) {
      const candidate = history[index];
      if (candidate.currentPlayer === VIEWER_PLAYER_ID && candidate.pendingMove === null) {
        restoreIndex = index;
        break;
      }
    }
    if (restoreIndex < 0) {
      setMessage('There is no earlier saved turn to restore. Future turns are now being saved.');
      return;
    }

    const restored = history[restoreIndex];
    historyRef.current = history.slice(0, restoreIndex + 1);
    restoringHistoryRef.current = true;
    setHistoryDepth(historyRef.current.length);
    window.localStorage.setItem(SAVED_HISTORY_KEY, JSON.stringify(historyRef.current));
    setOpponentMovePreview(null);
    setGame(restored);
    clearSelection();
    setMessage('Your last turn and Player 2 response were undone. Try the move again.');
  }

  const playerCanAct = game.currentPlayer === VIEWER_PLAYER_ID && game.phase !== 'complete' && !qualifierDuel?.spectating && !isAnimating;
  const requiredTop = getRequiredMatchingBuildGroup(game) ?? getRequiredExposedGroup(game);
  const selectedLooseCards = selectedFloorIds
    .map((cardId) => game.floor.find((card) => card.id === cardId))
    .filter((card): card is Card => Boolean(card));
  const selectedBuildPublicCards = exposedSelected && opponent.captured.at(-1)
    ? [opponent.captured.at(-1)!, ...selectedLooseCards]
    : selectedLooseCards;
  const placementOptions = selectedHand
    ? getLoosePlacementOptions(selectedHand, selectedLooseCards, viewer.hand, game.floor)
    : null;
  const buildPlacementOptions = selectedHand
    ? getLoosePlacementOptions(selectedHand, selectedBuildPublicCards, viewer.hand, game.floor)
    : null;
  const ownBuild = game.builds.find(viewerControlsBuild);
  const canContinueOwnBuild = Boolean(
    ownBuild && buildPlacementOptions?.choices.includes('build') &&
    buildPlacementOptions.buildTarget === ownBuild.targetValue
  );
  const inferredBuildTarget = buildPlacementOptions?.buildTarget ?? null;
  const canBuildLoose = buildPlacementOptions?.choices.includes('build') ?? false;
  const canStay = placementOptions?.choices.includes('stay') ?? false;
  const selectedBuild = selectedBuildId ? game.builds.find((build) => build.id === selectedBuildId) : null;
  const canStayOnBuild = Boolean(
    selectedHand &&
    selectedBuild && viewerControlsBuild(selectedBuild) &&
    selectedHand.value === selectedBuild.targetValue &&
    viewer.hand.some((card) => card.id !== selectedHand.id && card.value === selectedBuild.targetValue)
  );
  const capturePlanCards = selectedHand ? [
    ...selectedLooseCards.filter((card) => card.value === selectedHand.value),
    ...(exposedSelected && opponent.captured.at(-1) ? [opponent.captured.at(-1)!] : []),
    ...selectedLooseCards.filter((card) => card.value !== selectedHand.value),
  ] : [];
  const selectedCapturePlan = selectedHand
    ? getCapturePlan(capturePlanCards, selectedHand.value)
    : null;
  const partnerBuildBlocksTake = Boolean(
    selectedBuild && viewerControlsBuild(selectedBuild) && selectedBuild.ownerPlayerId !== VIEWER_PLAYER_ID,
  );
  const canTake = Boolean(
    selectedHand && !partnerBuildBlocksTake && (selectedCapturePlan || selectedBuild?.targetValue === selectedHand.value),
  );
  const selectedDirectMatches = selectedHand
    ? selectedLooseCards.filter((card) => card.value === selectedHand.value)
    : [];
  const forcedOwnBuildTake = Boolean(
    selectedHand && ownBuild?.ownerPlayerId === VIEWER_PLAYER_ID && selectedHand.value === ownBuild.targetValue &&
    !viewer.hand.some((card) => card.id !== selectedHand.id && card.value === ownBuild.targetValue)
  );
  const takingBuild = Boolean(selectedBuildId || forcedOwnBuildTake);

  return (
    <main className="game-shell">
      <header className="top-bar">
        <div className="brand-block">
          <span className="brand-mark">ZC</span>
          <div><h1>Zulu Casino</h1><p>{qualifierDuel ? 'Qualifier 1v1 duel' : MODE_LABELS[game.mode ?? 'classic-1v1']} test table</p></div>
        </div>
        <div className="round-display">
          <span>{game.phase === 'complete'
            ? 'Game over'
            : (game.mode ?? 'classic-1v1') === 'classic-1v1' ? getRoundLabel(game.round) : 'Single deal'}</span>
          <strong>{game.deck.length}</strong> in deck
        </div>
        <div className="table-controls">
          <div className="auth-controls" aria-label="Player account">
            <Show when="signed-out">
              <SignInButton mode="modal">
                <button className="secondary-button">Sign in</button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button className="account-button">Create account</button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">
              <UserButton
                showName
                appearance={{
                  elements: {
                    userButtonBox: 'clerk-user-box',
                    userButtonOuterIdentifier: 'clerk-user-name',
                  },
                }}
              />
            </Show>
          </div>
          <label className="mode-picker">
            <span>Mode</span>
            <select
              value={qualifierDuel ? 'three-hand-qualifier' : game.mode ?? 'classic-1v1'}
              onChange={(event) => handleNewGame(event.target.value as GameMode)}
              aria-label="Game mode"
              disabled={isAnimating}
            >
              {Object.entries(MODE_LABELS).map(([mode, label]) => (
                <option key={mode} value={mode}>{label}</option>
              ))}
            </select>
          </label>
          <div className="difficulty-control" role="group" aria-label="Player 2 learning level">
            {(['easy', 'medium', 'hard'] as BotDifficulty[]).map((difficulty) => (
              <button
                key={difficulty}
                className={botDifficulty === difficulty ? 'active' : ''}
                onClick={() => handleDifficultyChange(difficulty)}
                aria-pressed={botDifficulty === difficulty}
                disabled={isAnimating}
              >
                {difficulty}
              </button>
            ))}
          </div>
          <div className="settings-wrap">
            <button
              className="secondary-button settings-button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-label="Game settings"
            >Settings</button>
            {settingsOpen && (
              <div className="settings-panel">
                <strong>Table preferences</strong>
                <label><input type="checkbox" checked={preferences.soundEffects} onChange={() => updatePreference('soundEffects')} /> Sound effects</label>
                <label><input type="checkbox" checked={preferences.shuffleAnimation} onChange={() => updatePreference('shuffleAnimation')} /> Shuffle animation</label>
                <label><input type="checkbox" checked={preferences.dealAnimation} onChange={() => updatePreference('dealAnimation')} /> Deal animation</label>
              </div>
            )}
          </div>
          <button className="secondary-button" onClick={handleUndoTurn} disabled={historyDepth < 2 || isAnimating}>Undo my turn</button>
          <button className="secondary-button" onClick={() => handleNewGame()} disabled={isAnimating}>New deal</button>
        </div>
      </header>

      <div className="table-wrap">
        <div className={`table-felt ${isAnimating ? 'interaction-locked' : ''}`} aria-busy={isAnimating}>
          {isAnimating && (
            <div className="table-animation-layer" aria-label={tableAnimation.phase === 'shuffle' ? 'Shuffling cards' : 'Dealing cards'}>
              {tableAnimation.phase === 'shuffle' ? (
                <div className="shuffle-pack">
                  {[0, 1, 2, 3, 4].map((index) => <PlayingCard key={index} faceDown className={`shuffle-card shuffle-card-${index}`} />)}
                  <span>Shuffling</span>
                </div>
              ) : tableAnimation.destinationPlayerId ? (
                <div
                  key={tableAnimation.cardSequence}
                  className="dealing-card"
                  style={(() => {
                    const playerId = tableAnimation.destinationPlayerId!;
                    if (playerId === VIEWER_PLAYER_ID) return { '--deal-x': '0px', '--deal-y': '34vh' } as CSSProperties;
                    const publicIndex = publicPlayerIds.indexOf(playerId);
                    const positions = publicPlayerIds.length === 1
                      ? [['0px', '-34vh']]
                      : publicPlayerIds.length === 2
                        ? [['-28vw', '-30vh'], ['28vw', '-30vh']]
                        : [['-31vw', '-29vh'], ['0px', '-34vh'], ['31vw', '-29vh']];
                    const [x, y] = positions[publicIndex] ?? ['0px', '-34vh'];
                    return { '--deal-x': x, '--deal-y': y } as CSSProperties;
                  })()}
                >
                  <PlayingCard faceDown />
                </div>
              ) : null}
              {tableAnimation.phase === 'deal' && (
                <div className="deck-anchor"><PlayingCard faceDown /><span>Deck</span></div>
              )}
            </div>
          )}
          {game.turnOrder.length === 2 ? (
          <PlayerArea
            player={opponent}
            isCurrent={game.currentPlayer === AUTO_PLAYER_ID && game.phase !== 'complete'}
            position="top"
            hideHand
            visibleHandCount={isAnimating ? tableAnimation.visibleHandCounts[opponent.id] ?? 0 : undefined}
            interactionLocked={isAnimating}
            exposedSelected={exposedSelected}
            exposedStaged={Boolean(exposedSelected && selectedBuildId && game.builds.find((build) => build.id === selectedBuildId)?.ownerPlayerId === VIEWER_PLAYER_ID)}
            onExposedClick={playerCanAct ? () => {
              const ownBuild = game.builds.find((build) => build.ownerPlayerId === VIEWER_PLAYER_ID);
              const exposed = opponent.captured.at(-1);
              if (
                selectedHand && ownBuild && exposed &&
                selectedHand.value === ownBuild.targetValue &&
                exposed.value === ownBuild.targetValue &&
                viewer.hand.some((card) => card.id !== selectedHand.id && card.value === ownBuild.targetValue)
              ) {
                setSelectedBuildId(ownBuild.id);
                setExposedSelected(true);
                setMessage(`Exposed ${exposed.value} selected. Choose Stay ${ownBuild.targetValue} or Take.`);
                return;
              }
              if (selectedHand && ownBuild && exposed && selectedHand.value + exposed.value === ownBuild.targetValue) {
                setSelectedBuildId(ownBuild.id);
                setExposedSelected(true);
                setMessage(`${exposed.value} + ${selectedHand.value} can continue Build ${ownBuild.targetValue}.`);
                return;
              }
              setExposedSelected((selected) => !selected);
            } : undefined}
            onExposedDrop={playerCanAct && draggedHandId
              ? () => handleDropOnExposed(draggedHandId)
              : undefined}
            onExposedDragStart={playerCanAct ? () => {
              const exposed = opponent.captured.at(-1);
              if (exposed) {
                setDraggedExposedId(exposed.id);
                setDraggedHandId(null);
              }
            } : undefined}
            onExposedDragEnd={() => setDraggedExposedId(null)}
            build={game.builds.find((build) => buildTablePlayerId(build) === AUTO_PLAYER_ID)}
            buildResponsibleName={(() => {
              const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === AUTO_PLAYER_ID);
              return build && build.ownerPlayerId !== AUTO_PLAYER_ID ? game.players[build.ownerPlayerId].name : undefined;
            })()}
            buildSelected={game.builds.some((build) => buildTablePlayerId(build) === AUTO_PLAYER_ID && build.id === selectedBuildId)}
            buildAnimating={Boolean(opponentMovePreview?.decisionShown && opponentMovePreview.buildId && game.builds.some((build) => buildTablePlayerId(build) === AUTO_PLAYER_ID && build.id === opponentMovePreview.buildId))}
            showInventoryCount={game.phase === 'complete'}
            onBuildClick={playerCanAct ? () => {
              const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === AUTO_PLAYER_ID);
              if (build) {
                setSelectedBuildId((id) => id === build.id ? null : build.id);
                if (selectedHand?.value === build.targetValue) setMessage(`Take Build ${build.targetValue} is ready.`);
              }
            } : undefined}
            onBuildDrop={playerCanAct && draggedHandId
              ? () => {
                const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === AUTO_PLAYER_ID);
                if (build) handleTakeBuild(draggedHandId, build.id);
              }
              : undefined}
            onPlayCard={() => undefined}
          />
          ) : (
            <section className={`multi-seat-row seats-${game.turnOrder.length}`} aria-label="Other player seats">
              {publicPlayerIds.map((playerId) => {
                const player = game.players[playerId];
                const exposed = player.captured.at(-1);
                const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === playerId);
                const isPartner = game.mode === 'partners-2v2' && (
                  game.playerTeams?.[playerId] === game.playerTeams?.[VIEWER_PLAYER_ID]
                );
                return (
                  <article
                    key={playerId}
                    className={`compact-seat seat-${playerId} ${game.currentPlayer === playerId ? 'current' : ''} ${isPartner ? 'partner-seat' : 'opponent-seat'}`}
                  >
                    <header>
                      <span className={`turn-light ${game.currentPlayer === playerId ? 'active' : ''}`} />
                      <strong>{player.name}</strong>
                      <small>{isPartner
                        ? `Partner · ${isAnimating ? tableAnimation.visibleHandCounts[playerId] ?? 0 : player.hand.length} cards`
                        : `${isAnimating ? tableAnimation.visibleHandCounts[playerId] ?? 0 : player.hand.length} cards`}</small>
                    </header>
                    <div className="compact-public-zones">
                      <div>
                        <span>Inventory</span>
                        {exposed ? (
                          <PlayingCard
                            card={exposed}
                            selected={exposedSelected && activePublicId === playerId}
                            onClick={playerCanAct && !isPartner ? () => {
                              setActivePublicPlayerId(playerId);
                              setExposedSelected((selected) => activePublicId === playerId ? !selected : true);
                              setMessage(`${player.name}'s exposed ${exposed.value} selected.`);
                            } : undefined}
                          />
                        ) : <i>Empty</i>}
                      </div>
                      <div>
                        <span>Build</span>
                        {build ? (
                          <button onClick={playerCanAct ? () => {
                            setActivePublicPlayerId(playerId);
                            setSelectedBuildId((id) => id === build.id ? null : build.id);
                            setMessage(`${player.name}'s Build ${build.targetValue} selected.`);
                          } : undefined}>
                            <strong>{build.targetValue}</strong>
                            <small>{build.secured ? 'Secured' : 'Open'}</small>
                          </button>
                        ) : <i>Empty</i>}
                      </div>
                    </div>
                    <div className="compact-hand" aria-label={`${player.name} hidden hand`}>
                      {player.hand
                        .slice(0, isAnimating ? tableAnimation.visibleHandCounts[playerId] ?? 0 : 10)
                        .map((card) => <PlayingCard key={card.id} faceDown />)}
                    </div>
                  </article>
                );
              })}
            </section>
          )}

          <section className="floor-zone" aria-label="Floor cards">
            <div className="floor-header">
              <span>Floor · {game.floor.length}</span>
              <span className="turn-copy">
                {game.phase === 'complete' ? 'Scoring complete' : `${game.players[game.currentPlayer].name}'s turn`}
              </span>
            </div>

            <div className="loose-lane">
              <span className="lane-label">Loose cards</span>
              <div
                className={`floor-cards ${draggedHandId ? 'drop-ready' : ''} ${
                  opponentMovePreview?.decisionShown
                    ? opponentMovePreview.choice === 'take'
                      ? 'opponent-take-impact'
                      : 'opponent-drop-impact'
                    : ''
                }`}
                onDragOver={playerCanAct && draggedHandId ? (event) => event.preventDefault() : undefined}
                onDrop={playerCanAct && draggedHandId ? (event) => {
                  event.preventDefault();
                  handleDropToFloor(draggedHandId);
                } : undefined}
                onClick={playerCanAct && selectedHand && !placementActive ? (event) => {
                  if ((event.target as HTMLElement).closest('.playing-card, .placement-preview, .opponent-play-preview')) return;
                  handleDropToFloor(selectedHand.id);
                } : undefined}
              >
                {opponentMovePreview && (
                  <div
                    className={`opponent-play-preview ${opponentMovePreview.decisionShown ? `impact-${opponentMovePreview.choice}` : ''}`}
                    aria-label={`Player 2 placed ${opponentMovePreview.card.value}`}
                  >
                    <PlayingCard card={opponentMovePreview.card} className="opponent-placed-card" />
                    {opponentMovePreview.decisionShown && (
                      <span>{opponentMovePreview.choice === 'take' ? 'Take' : 'Drop'}</span>
                    )}
                  </div>
                )}
                {game.floor.length ? game.floor.map((card) => (
                  <PlayingCard
                    key={card.id}
                    card={card}
                    selected={selectedFloorIds.includes(card.id)}
                    className={opponentMovePreview?.decisionShown && opponentMovePreview.floorCardIds.includes(card.id) ? 'opponent-choice-card' : undefined}
                    draggable={playerCanAct && !selectedHand && !game.pendingMove}
                    onDragStart={playerCanAct && !selectedHand ? () => {
                      setDraggedFloorId(card.id);
                      setDraggedHandId(null);
                    } : undefined}
                    onDragEnd={() => setDraggedFloorId(null)}
                    onDrop={playerCanAct
                      ? draggedHandId
                        ? () => handlePlaceOnLoose(card.id, draggedHandId)
                        : draggedFloorId
                          ? () => handleStackLoose(draggedFloorId, card.id)
                          : undefined
                      : undefined}
                    onClick={playerCanAct ? () => {
                      if (selectedHand) {
                        handlePlaceOnLoose(card.id, selectedHand.id);
                        return;
                      }
                      setSelectedFloorIds((ids) => ids.includes(card.id)
                        ? ids.filter((id) => id !== card.id)
                        : [...ids, card.id]);
                    } : undefined}
                  />
                )) : <span className="floor-empty">Floor is clear</span>}
                {!selectedHand && selectedLooseCards.length > 1 && (
                  <div className="placement-preview" aria-label="Staged loose-card group">
                    <span className="preview-card-stack">
                      {orderBuildGroup(selectedLooseCards).map((card) => <PlayingCard key={card.id} card={card} />)}
                    </span>
                    <small>Floor group</small>
                  </div>
                )}
                {placementActive && selectedHand && selectedLooseCards.length > 0 && (
                  <div className="placement-preview" aria-label="Pending card placement">
                    <span className="preview-card-stack">
                      {selectedLooseCards.map((card) => <PlayingCard key={card.id} card={card} />)}
                      <PlayingCard card={selectedHand} />
                    </span>
                    <small>Pending</small>
                  </div>
                )}
              </div>
            </div>

            <div className="move-console">
              {partnerStayOffer ? (
                <>
                  <span className="pending-label">Partner declared Take</span>
                  <button className="primary-button" onClick={handleCallPartnerStay}>Call Stay</button>
                  <button className="secondary-button" onClick={handleAllowPartnerTake}>Let Take</button>
                </>
              ) : game.pendingMove?.playerId === VIEWER_PLAYER_ID ? (
                <>
                  <span className="pending-label">Pending {game.pendingMove.targetValue} · {game.pendingMove.mode.replaceAll('-', ' ')}</span>
                  <button className="secondary-button" onClick={handleResolvePublic}>Use selected cards</button>
                  <button className="secondary-button" onClick={handleRequiredTop} disabled={!requiredTop}>Resolve exposed top</button>
                  <button className="primary-button" onClick={handleCommit}>Commit &amp; take home</button>
                </>
              ) : (
                <>
                  <button className="secondary-button" onClick={handleDrop} disabled={!playerCanAct || !selectedHand || placementActive}>Drop</button>
                  {canTake && (
                    <button className="primary-button" onClick={handleBeginCapture}>
                      {takingBuild
                        ? `Take Build${selectedFloorIds.length ? ' + Floor' : ''} ${selectedHand?.value}`
                        : `Take ${selectedHand?.value}`}
                    </button>
                  )}
                  {!canTake && selectedDirectMatches.length > 0 && (
                    <button className="primary-button" onClick={handleDirectMatches}>
                      Take matching {selectedHand?.value}
                    </button>
                  )}
                  {canStay && !selectedBuildId && (
                    <button className="secondary-button" onClick={handleStay}>Stay {selectedHand?.value}</button>
                  )}
                  {canContinueOwnBuild && !selectedBuildId && ownBuild && (
                    <button className="secondary-button" onClick={() => handleBuildAction('continue-build', ownBuild.id)}>
                      Continue {ownBuild.targetValue}
                    </button>
                  )}
                  {canBuildLoose && !canContinueOwnBuild && !selectedBuildId && (
                    <button className="secondary-button" onClick={handleBuildFromLoose}>Build {inferredBuildTarget}</button>
                  )}
                  {placementActive && <button className="secondary-button" onClick={clearSelection}>Cancel</button>}
                  {selectedBuildId && (
                    <>
                      <button className="secondary-button" onClick={() => handleBuildAction('continue-build')} disabled={!selectedHand}>Continue</button>
                      {!selectedBuild || !viewerControlsBuild(selectedBuild) ? (
                        <button className="secondary-button" onClick={() => handleBuildAction('manipulate-build')} disabled={!selectedHand}>Raise</button>
                      ) : null}
                      {canStayOnBuild && (
                        <button className="secondary-button" onClick={() => handleBuildAction('secure-build')}>Stay {selectedBuild?.targetValue}</button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </section>

          <PlayerArea
            player={viewer}
            isCurrent={playerCanAct}
            position="bottom"
            visibleHandCount={isAnimating ? tableAnimation.visibleHandCounts[VIEWER_PLAYER_ID] ?? 0 : undefined}
            interactionLocked={isAnimating}
            hideHand={Boolean(qualifierDuel?.spectating)}
            selectedHandCardId={selectedHandId}
            exposedAnimating={Boolean(opponentMovePreview?.decisionShown && opponentMovePreview.exposedInventory)}
            exposedActionLabel={opponentMovePreview?.decisionShown && opponentMovePreview.exposedCardTaken
              ? `Player 2 takes ${opponentMovePreview.exposedCardTaken.value}`
              : undefined}
            build={game.builds.find((build) => buildTablePlayerId(build) === VIEWER_PLAYER_ID)}
            buildResponsibleName={(() => {
              const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === VIEWER_PLAYER_ID);
              return build && build.ownerPlayerId !== VIEWER_PLAYER_ID ? game.players[build.ownerPlayerId].name : undefined;
            })()}
            stagedBuildCards={exposedSelected && selectedBuildId && opponent.captured.at(-1)
              ? [opponent.captured.at(-1)!]
              : []}
            buildSelected={game.builds.some((build) => buildTablePlayerId(build) === VIEWER_PLAYER_ID && build.id === selectedBuildId)}
            buildAnimating={Boolean(opponentMovePreview?.decisionShown && opponentMovePreview.buildId && game.builds.some((build) => buildTablePlayerId(build) === VIEWER_PLAYER_ID && build.id === opponentMovePreview.buildId))}
            showInventoryCount={game.phase === 'complete'}
            onBuildClick={playerCanAct ? () => {
              const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === VIEWER_PLAYER_ID);
              if (build) {
                setSelectedBuildId((id) => id === build.id ? null : build.id);
                if (selectedHand?.value === build.targetValue) setMessage(`Take Build ${build.targetValue} is ready.`);
              }
            } : undefined}
            onBuildDrop={playerCanAct && (draggedHandId || draggedExposedId)
              ? () => {
                const build = game.builds.find((candidate) => buildTablePlayerId(candidate) === VIEWER_PLAYER_ID);
                if (!build) return;
                if (draggedExposedId) handleStageExposedOnBuild(build.id);
                else if (draggedHandId) handleDropOnBuild(draggedHandId, build.id);
              }
              : undefined}
            onHandDragStart={(cardId) => {
              setDraggedHandId(cardId);
              setSelectedHandId(cardId);
            }}
            onPlayCard={(_, cardId) => {
              if (!playerCanAct || game.pendingMove) return;
              setSelectedHandId((id) => id === cardId ? null : cardId);
              setPlacementActive(selectedFloorIds.length > 0);
            }}
          />

          {game.phase === 'complete' && game.score && (
            <section className="score-panel score-audit-panel" aria-label="Final score audit">
              <header>
                <span>Final score audit</span>
                <strong>
                  {game.score.teams
                    ? Object.values(game.score.teams).map((score) => score.total).join(' - ')
                    : game.turnOrder.map((id) => game.score!.players[id].total).join(' - ')}
                </strong>
              </header>
              {game.score.teams && (
                <div className="team-score-summary">
                  {Object.entries(game.score.teams).map(([teamId, score]) => (
                    <div key={teamId} className={teamId === game.score?.winnerTeamId ? 'winner' : ''}>
                      <span>{teamId === 'team-a' ? 'Your team' : 'Opposing team'}</span>
                      <strong>{score.total}</strong>
                    </div>
                  ))}
                </div>
              )}
              {game.turnOrder.map((playerId) => {
                const player = game.players[playerId];
                const score = game.score!.players[playerId];
                const scoringCards = player.captured.filter((card) => (
                  card.value === 1 || card.id === 'diamonds-10' || card.id === 'spades-2'
                ));
                const spadeCount = player.captured.filter((card) => card.suit === 'spades').length;
                return (
                  <article className="score-player" key={playerId}>
                    <div className="score-player-heading">
                      <h3>{player.name}</h3>
                      <strong>{score.total}</strong>
                    </div>
                    <div className="scoring-card-row" aria-label={`${player.name} scoring cards`}>
                      {scoringCards.length
                        ? scoringCards.map((card) => <PlayingCard key={card.id} card={card} />)
                        : <span>No individual card points</span>}
                    </div>
                    <dl className="score-breakdown">
                      <div><dt>Aces</dt><dd>{score.aces}</dd></div>
                      <div><dt>10 of Diamonds</dt><dd>{score.tenOfDiamonds}</dd></div>
                      <div><dt>2 of Spades</dt><dd>{score.twoOfSpades}</dd></div>
                      {(game.mode ?? 'classic-1v1') === 'classic-1v1' && (
                        <><div><dt>Spades ({spadeCount} of 10)</dt><dd>{score.spades}</dd></div>
                        <div><dt>Captured cards ({player.captured.length} of 40)</dt><dd>{score.cards}</dd></div></>
                      )}
                    </dl>
                  </article>
                );
              })}
              <p>
                {game.score.winnerTeamId
                  ? `${game.score.winnerTeamId === game.playerTeams?.[VIEWER_PLAYER_ID] ? 'Your team' : 'Opposing team'} wins`
                  : game.score.isDraw
                    ? game.mode === 'three-hand-qualifier' ? 'Draw · replay three-hand' : 'Draw'
                    : `${game.players[game.score.winnerPlayerId].name} wins`}
                {' · '}{game.score.combinedPoints} points verified
              </p>
              {game.mode === 'three-hand-qualifier' && (
                <button className="primary-button score-next-button" onClick={handleQualifierAdvance}>
                  {game.score.isDraw ? 'Replay 3-Hand' : 'Start qualifying 1v1'}
                </button>
              )}
              {qualifierDuel && (
                <button className="primary-button score-next-button" onClick={() => handleNewGame('three-hand-qualifier')}>
                  Return all players to 3-Hand
                </button>
              )}
            </section>
          )}
        </div>
      </div>

      <footer className="status-bar">
        <span className={`integrity-dot ${validation.valid ? 'valid' : 'invalid'}`} />
        <strong>{validation.valid ? '40 cards accounted for' : 'State integrity error'}</strong>
        <span>{message}</span>
        <span className="capture-status">Last capture: {game.lastPlayerToCapture ? game.players[game.lastPlayerToCapture].name : 'None'}</span>
      </footer>
    </main>
  );
}
