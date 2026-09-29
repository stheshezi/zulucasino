export type GameSound =
  | 'card-deal'
  | 'card-play'
  | 'card-flip'
  | 'shuffle'
  | 'invalid-move'
  | 'take'
  | 'game-start'
  | 'win'
  | 'lose';

const SOUND_FILES: Record<GameSound, string> = {
  'card-deal': '/sounds/keyswipe-card.mp3',
  'card-play': '/sounds/placing-playing-card.mp3',
  'card-flip': '/sounds/flipcard.mp3',
  shuffle: '/sounds/riffle-shuffle.mp3',
  'invalid-move': '/sounds/card-collisions.mp3',
  take: '/sounds/taking-playing-card.mp3',
  'game-start': '/sounds/game-start.mp3',
  win: '/sounds/player-wins.mp3',
  lose: '/sounds/game-over-on-lose.mp3',
};

class SoundPlayer {
  private enabled = true;
  private readonly sounds = new Map<GameSound, HTMLAudioElement>();

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.sounds.forEach((audio) => audio.pause());
  }

  preload() {
    if (typeof Audio === 'undefined') return;
    (Object.keys(SOUND_FILES) as GameSound[]).forEach((sound) => this.get(sound));
  }

  play(sound: GameSound, volume = 0.55) {
    if (!this.enabled || typeof Audio === 'undefined') return;
    const source = this.get(sound);
    source.volume = volume;
    source.currentTime = 0;
    void source.play().catch(() => undefined);
  }

  private get(sound: GameSound) {
    const existing = this.sounds.get(sound);
    if (existing) return existing;
    const audio = new Audio(SOUND_FILES[sound]);
    audio.preload = 'auto';
    this.sounds.set(sound, audio);
    return audio;
  }
}

export const gameSounds = new SoundPlayer();
