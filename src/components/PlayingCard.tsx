import { Card } from '../game';

const SUIT_SYMBOLS: Record<Card['suit'], string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
};

interface PlayingCardProps {
  card?: Card;
  faceDown?: boolean;
  selected?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
  className?: string;
  label?: string;
}

export function PlayingCard({ card, faceDown, selected, onClick, draggable, onDragStart, onDragEnd, onDrop, className, label }: PlayingCardProps) {
  const isRed = card?.suit === 'diamonds' || card?.suit === 'hearts';
  const classNames = ['playing-card', faceDown ? 'card-back' : '', isRed ? 'card-red' : '', selected ? 'selected' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  if (faceDown || !card) {
    return <div className={classNames} aria-label={label ?? 'Face-down card'} />;
  }

  const content = (
    <>
      <span className="card-corner">{card.value}<span>{SUIT_SYMBOLS[card.suit]}</span></span>
      <span className="card-suit">{SUIT_SYMBOLS[card.suit]}</span>
      <span className="card-corner card-corner-bottom">{card.value}<span>{SUIT_SYMBOLS[card.suit]}</span></span>
    </>
  );

  return onClick ? (
    <button
      className={classNames}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDrop ? (event) => event.preventDefault() : undefined}
      onDrop={onDrop ? (event) => { event.preventDefault(); event.stopPropagation(); onDrop(); } : undefined}
      aria-label={`Select ${card.value} of ${card.suit}`}
    >
      {content}
    </button>
  ) : (
    <div className={classNames} aria-label={`${card.value} of ${card.suit}`}>
      {content}
    </div>
  );
}
