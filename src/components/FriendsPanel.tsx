import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, useUser } from '@clerk/react';

interface PlayerSummary {
  playerId: string;
  displayName: string;
  username: string | null;
  imageUrl: string;
}

interface Challenge {
  id: string;
  from: PlayerSummary;
  to: PlayerSummary;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: string;
  matchId?: string;
}

interface NetworkState {
  friends: PlayerSummary[];
  incoming: Challenge[];
  outgoing: Challenge[];
  activeMatch?: {
    matchId: string;
    opponent: PlayerSummary;
  };
}

interface FriendsPanelProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY_NETWORK: NetworkState = { friends: [], incoming: [], outgoing: [] };

export function FriendsPanel({ open, onClose }: FriendsPanelProps) {
  const { user } = useUser();
  const { getToken } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlayerSummary[]>([]);
  const [network, setNetwork] = useState<NetworkState>(EMPTY_NETWORK);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [networkAvailable, setNetworkAvailable] = useState(true);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Player network request failed.');
    return data;
  }, [getToken]);

  const refresh = useCallback(async (quiet = false) => {
    if (!user) return;
    try {
      const data = await api('/api/challenges');
      setNetwork(data);
      setNetworkAvailable(true);
    } catch (error) {
      setNetworkAvailable(false);
      if (!quiet) setMessage(error instanceof Error ? error.message : 'Player network unavailable.');
    }
  }, [api, user]);

  useEffect(() => {
    if (!user) return;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(true), 3000);
    return () => window.clearInterval(timer);
  }, [refresh, user]);

  const pendingIncoming = useMemo(() => (
    network.incoming.find((challenge) => challenge.status === 'pending')
  ), [network.incoming]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      await refresh(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  function searchPlayers() {
    const value = query.trim();
    if (value.length < 2) {
      setMessage('Enter at least two letters of a name, username, or a Player ID.');
      return;
    }
    void run(async () => {
      const data = await api(`/api/challenges?query=${encodeURIComponent(value)}`);
      setResults(data.players ?? []);
      setMessage(data.players?.length ? '' : 'No matching player was found.');
    });
  }

  function addFriend(player: PlayerSummary) {
    void run(async () => {
      await api('/api/challenges', {
        method: 'POST',
        body: JSON.stringify({ action: 'addFriend', targetPlayerId: player.playerId }),
      });
      setMessage(`${player.displayName} was added to your friends.`);
    });
  }

  function challenge(player: PlayerSummary) {
    void run(async () => {
      await api('/api/challenges', {
        method: 'POST',
        body: JSON.stringify({ action: 'sendChallenge', targetPlayerId: player.playerId }),
      });
      setMessage(`Challenge sent to ${player.displayName}.`);
    });
  }

  function respond(challengeRequest: Challenge, decision: 'accepted' | 'declined') {
    void run(async () => {
      await api('/api/challenges', {
        method: 'POST',
        body: JSON.stringify({ action: 'respond', challengeId: challengeRequest.id, decision }),
      });
      setMessage(decision === 'accepted'
        ? `Challenge accepted. ${challengeRequest.from.displayName} has been notified.`
        : 'Challenge declined.');
    });
  }

  if (!user) return null;

  const displayName = user.username || user.fullName || 'Zulu Casino player';

  return (
    <>
      {pendingIncoming && (
        <aside className="challenge-toast" role="dialog" aria-live="assertive" aria-label="Incoming game challenge">
          <div className="player-avatar">
            {pendingIncoming.from.imageUrl
              ? <img src={pendingIncoming.from.imageUrl} alt="" />
              : pendingIncoming.from.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span>Incoming challenge</span>
            <strong>{pendingIncoming.from.displayName}</strong>
            <p>wants to play Classic 1v1.</p>
          </div>
          <button className="account-button" disabled={busy} onClick={() => respond(pendingIncoming, 'accepted')}>Accept</button>
          <button className="secondary-button" disabled={busy} onClick={() => respond(pendingIncoming, 'declined')}>Decline</button>
        </aside>
      )}

      {network.activeMatch && !pendingIncoming && (
        <aside className="match-ready-toast" role="status">
          <span>Match ready</span>
          <strong>{network.activeMatch.opponent.displayName}</strong>
          <p>Both players accepted. Online table syncing comes next.</p>
        </aside>
      )}

      {open && (
        <div className="friends-backdrop" onMouseDown={onClose}>
          <section className="friends-panel" aria-label="Friends and challenges" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>Player network</span>
                <h2>{displayName}</h2>
              </div>
              <button className="panel-close" onClick={onClose} aria-label="Close friends panel">×</button>
            </header>

            {!networkAvailable && (
              <p className="network-warning">Online challenges are reconnecting. Your table can still be played locally.</p>
            )}

            <div className="player-id-block">
              <span>Your Player ID</span>
              <code>{user.id}</code>
            </div>

            <div className="friend-search">
              <label htmlFor="friend-player-search">Find a player</label>
              <div>
                <input
                  id="friend-player-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && searchPlayers()}
                  placeholder="Name, username, or Player ID"
                  autoComplete="off"
                />
                <button className="account-button" disabled={busy} onClick={searchPlayers}>Search</button>
              </div>
            </div>

            {results.length > 0 && (
              <div className="player-results">
                <span>Players</span>
                {results.map((player) => {
                  const isFriend = network.friends.some((friend) => friend.playerId === player.playerId);
                  return (
                    <article key={player.playerId}>
                      <div className="player-avatar">
                        {player.imageUrl ? <img src={player.imageUrl} alt="" /> : player.displayName.slice(0, 1).toUpperCase()}
                      </div>
                      <div><strong>{player.displayName}</strong><small>{player.username ? `@${player.username}` : 'Zulu Casino player'}</small></div>
                      {isFriend
                        ? <button className="secondary-button" disabled={busy} onClick={() => challenge(player)}>Challenge</button>
                        : <button className="account-button" disabled={busy} onClick={() => addFriend(player)}>Add Friend</button>}
                    </article>
                  );
                })}
              </div>
            )}

            <div className="friends-list">
              <span>Friends · {network.friends.length}</span>
              {network.friends.length ? network.friends.map((friend) => {
                const waiting = network.outgoing.some((item) => item.to.playerId === friend.playerId && item.status === 'pending');
                return (
                  <article key={friend.playerId}>
                    <div><strong>{friend.displayName}</strong><small>{friend.username ? `@${friend.username}` : 'Friend'}</small></div>
                    <button className="secondary-button" disabled={busy || waiting} onClick={() => challenge(friend)}>
                      {waiting ? 'Waiting' : 'Challenge'}
                    </button>
                  </article>
                );
              }) : <p>Search for a player to add your first friend.</p>}
            </div>

            {message && <p className="friends-message" role="status">{message}</p>}
          </section>
        </div>
      )}
    </>
  );
}
