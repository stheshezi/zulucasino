export interface GamePreferences {
  soundEffects: boolean;
  shuffleAnimation: boolean;
  dealAnimation: boolean;
}

const PREFERENCES_KEY = 'zulu-casino.preferences.v1';

export const DEFAULT_GAME_PREFERENCES: GamePreferences = {
  soundEffects: true,
  shuffleAnimation: true,
  dealAnimation: true,
};

export function loadGamePreferences(): GamePreferences {
  if (typeof window === 'undefined') return DEFAULT_GAME_PREFERENCES;
  try {
    return {
      ...DEFAULT_GAME_PREFERENCES,
      ...JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? '{}'),
    };
  } catch {
    return DEFAULT_GAME_PREFERENCES;
  }
}

export function saveGamePreferences(preferences: GamePreferences) {
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}
