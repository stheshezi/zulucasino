import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@clerk/react';

interface SavedFriend {
  playerId: string;
  label: string;
}

interface FriendsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function FriendsPanel({ open, onClose }: FriendsPanelProps) {
  const { user } = useUser();
  const [playerId, setPlayerId] = useState('');
  const [friends, setFriends] = useState<SavedFriend[]>([]);
  const [message, setMessage] = useState('');
  const storageKey = useMemo(() => user ? `zulu-casino.friends.${user.id}` : '', [user]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      setFriends(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'));
    } catch {
      setFriends([]);
    }
  }, [storageKey]);

  function saveFriends(next: SavedFriend[]) {
    setFriends(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  }

  async function copy(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
    } catch {
      setMessage('Copy failed. Select the Player ID manually.');
    }
  }

  function addFriend() {
    const cleanId = playerId.trim();
    if (!cleanId.startsWith('user_')) {
      setMessage('Enter a Clerk Player ID beginning with user_.');
      return;
    }
    if (cleanId === user?.id) {
      setMessage('That is your own Player ID.');
      return;
    }
    if (friends.some((friend) => friend.playerId === cleanId)) {
      setMessage('That player is already in your friend list.');
      return;
    }
    saveFriends([...friends, { playerId: cleanId, label: `Player ${friends.length + 1}` }]);
    setPlayerId('');
    setMessage('Friend saved for testing.');
  }

  function challenge(friend: SavedFriend) {
    if (!user) return;
    const url = new URL(window.location.origin);
    url.searchParams.set('challenge', user.id);
    url.searchParams.set('opponent', friend.playerId);
    void copy(url.toString(), `Challenge link copied for ${friend.label}.`);
  }

  if (!open || !user) return null;

  const displayName = user.fullName || user.primaryEmailAddress?.emailAddress || 'Zulu Casino player';

  return (
    <div className="friends-backdrop" onMouseDown={onClose}>
      <section className="friends-panel" aria-label="Friends and challenges" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>Player network</span>
            <h2>{displayName}</h2>
          </div>
          <button className="panel-close" onClick={onClose} aria-label="Close friends panel">×</button>
        </header>

        <div className="player-id-block">
          <span>Your Player ID</span>
          <code>{user.id}</code>
          <button className="secondary-button" onClick={() => void copy(user.id, 'Player ID copied.')}>Copy ID</button>
        </div>

        <div className="friend-search">
          <label htmlFor="friend-player-id">Find by Player ID</label>
          <div>
            <input
              id="friend-player-id"
              value={playerId}
              onChange={(event) => setPlayerId(event.target.value)}
              placeholder="user_..."
              autoComplete="off"
            />
            <button className="account-button" onClick={addFriend}>Add friend</button>
          </div>
        </div>

        <div className="friends-list">
          <span>Friends · {friends.length}</span>
          {friends.length ? friends.map((friend) => (
            <article key={friend.playerId}>
              <div><strong>{friend.label}</strong><code>{friend.playerId}</code></div>
              <button className="secondary-button" onClick={() => challenge(friend)}>Challenge</button>
              <button
                className="remove-friend"
                onClick={() => saveFriends(friends.filter((candidate) => candidate.playerId !== friend.playerId))}
                aria-label={`Remove ${friend.label}`}
              >×</button>
            </article>
          )) : <p>No friends saved yet.</p>}
        </div>

        {message && <p className="friends-message" role="status">{message}</p>}
      </section>
    </div>
  );
}
