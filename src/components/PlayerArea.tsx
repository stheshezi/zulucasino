import { Build, getBuildDisplayGroups, getExposedCapturedCard, Player, PlayerId } from '../game';
import { PlayingCard } from './PlayingCard';

interface PlayerAreaProps {
  player: Player;
  isCurrent: boolean;
  position: 'top' | 'bottom';
  hideHand?: boolean;
  selectedHandCardId?: Player['hand'][number]['id'] | null;
  exposedSelected?: boolean;
  exposedStaged?: boolean;
  onExposedClick?: () => void;
  onExposedDrop?: () => void;
  onExposedDragStart?: () => void;
  onExposedDragEnd?: () => void;
  build?: Build;
  buildResponsibleName?: string;
  stagedBuildCards?: Player['hand'];
  buildSelected?: boolean;
  onBuildClick?: () => void;
  onBuildDrop?: () => void;
  onHandDragStart?: (cardId: Player['hand'][number]['id']) => void;
  exposedAnimating?: boolean;
  exposedActionLabel?: string;
  buildAnimating?: boolean;
  showInventoryCount?: boolean;
  visibleHandCount?: number;
  interactionLocked?: boolean;
  onPlayCard: (playerId: PlayerId, cardId: Player['hand'][number]['id']) => void;
}

export function PlayerArea({
  player,
  isCurrent,
  position,
  hideHand = false,
  selectedHandCardId,
  exposedSelected,
  exposedStaged,
  onExposedClick,
  onExposedDrop,
  onExposedDragStart,
  onExposedDragEnd,
  build,
  buildResponsibleName,
  stagedBuildCards = [],
  buildSelected,
  onBuildClick,
  onBuildDrop,
  onHandDragStart,
  exposedAnimating,
  exposedActionLabel,
  buildAnimating,
  showInventoryCount = false,
  visibleHandCount,
  interactionLocked = false,
  onPlayCard,
}: PlayerAreaProps) {
  const exposedCard = getExposedCapturedCard(player);
  const buildGroups = build ? getBuildDisplayGroups(build) : [];
  const buildDisplayCards = buildGroups.flat();

  return (
    <section className={`player-area player-${position}`} aria-label={`${player.name} area`}>
      <div className="player-heading">
        <div>
          <span className={`turn-light ${isCurrent ? 'active' : ''}`} />
          <h2>{player.name}</h2>
        </div>
        <span>{visibleHandCount ?? player.hand.length} cards</span>
      </div>

      <div className="player-content">
        <div className="capture-zone">
          <span className="zone-label">
            Inventory{showInventoryCount ? ` · ${player.captured.length}` : ''}
          </span>
          <div className="captured-stack">
            {exposedCard && !exposedStaged ? (
              <PlayingCard
                card={exposedCard}
                selected={exposedSelected}
                onClick={onExposedClick}
                onDrop={onExposedDrop}
                draggable={Boolean(onExposedDragStart)}
                onDragStart={onExposedDragStart}
                onDragEnd={onExposedDragEnd}
                className={exposedAnimating ? 'opponent-taking' : undefined}
              />
            ) : <div className="empty-card-slot">{exposedStaged ? 'Pending' : 'Empty'}</div>}
          </div>
          {exposedCard && <span className="exposed-label">{exposedStaged ? 'Moved to build' : exposedActionLabel ?? 'Exposed top'}</span>}
        </div>

        <div className="player-build-zone">
          <span className="zone-label">Build</span>
          {build ? (
            <button
              className={`build-token ${buildSelected ? 'selected' : ''} ${buildAnimating ? 'opponent-taking-build' : ''}`}
              onClick={onBuildClick}
              onDragOver={onBuildDrop ? (event) => event.preventDefault() : undefined}
              onDrop={onBuildDrop ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onBuildDrop();
              } : undefined}
              aria-label={`${player.name} ${build.secured ? 'secured' : 'open'} build for ${build.targetValue}`}
            >
              <div
                className="build-card-stack"
                aria-label={`${buildGroups.length} groups stacked together in build ${build.targetValue}`}
              >
                {buildDisplayCards.map((card) => <PlayingCard key={card.id} card={card} />)}
                {stagedBuildCards.map((card) => <PlayingCard key={`staged-${card.id}`} card={card} className="staged-build-card" />)}
              </div>
              <span className="build-details">
                <strong>{build.targetValue}</strong>
                <span>{build.secured ? 'Secured' : 'Open'}</span>
                <small>{build.orderedCards.length} cards</small>
                {buildResponsibleName && <small>{buildResponsibleName} responsible</small>}
              </span>
            </button>
          ) : <div className="empty-build-slot">Build area</div>}
        </div>

        <div className="hand" aria-label={`${player.name} hand`}>
          {player.hand.slice(0, visibleHandCount ?? player.hand.length).map((card) => (
            <PlayingCard
              key={card.id}
              card={hideHand ? undefined : card}
              faceDown={hideHand}
              label={hideHand ? `${player.name} hidden card` : undefined}
              selected={selectedHandCardId === card.id}
              draggable={!hideHand && isCurrent && !interactionLocked}
              onDragStart={!hideHand && isCurrent && !interactionLocked ? () => onHandDragStart?.(card.id) : undefined}
              onClick={!hideHand && isCurrent && !interactionLocked ? () => onPlayCard(player.id, card.id) : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
