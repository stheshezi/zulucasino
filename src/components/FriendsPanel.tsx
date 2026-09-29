import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth, useUser } from '@clerk/react';
import type { GameMode } from '../game';

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
  mode: GameMode;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: string;
  matchId?: string;
  participants?: PlayerSummary[];
}

interface NetworkState {
  friends: PlayerSummary[];
  incoming: Challenge[];
  outgoing: Challenge[];
  activeMatch?: {
    matchId: string;
    opponent: PlayerSummary;
    participants?: PlayerSummary[];
    mode: GameMode;
  };
}

interface FriendsPanelProps {
  open: boolean;
  onClose: () => void;
  onJoinMatch: (match: {
    matchId: string;
    opponent: PlayerSummary;
    participants: PlayerSummary[];
    mode: GameMode;
  }) => Promise<void>;
  joinedMatchId: string | null;
}

const EMPTY_NETWORK: NetworkState = { friends: [], incoming: [], outgoing: [] };
const MODE_NAMES: Record<GameMode, string> = {
  'classic-1v1': 'Classic 1v1',
  'three-hand-rush': '3-Hand Rush',
  'three-hand-qualifier': 'Qualifier Rotation',
  'partners-2v2': 'Partners 2v2',
};

function playerCountForMode(mode: GameMode): number {
  if (mode === 'classic-1v1') return 2;
  if (mode === 'partners-2v2') return 4;
  return 3;
}

export function FriendsPanel({ open, onClose, onJoinMatch, joinedMatchId }: FriendsPanelProps) {
  const { user } = useUser();
  const { getToken } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlayerSummary[]>([]);
  const [network, setNetwork] = useState<NetworkState>(EMPTY_NETWORK);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [networkAvailable, setNetworkAvailable] = useState(true);
  const [tableMode, setTableMode] = useState<GameMode>('classic-1v1');
  const [selectedTablePlayerIds, setSelectedTablePlayerIds] = useState<string[]>([]);

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
      setNetwork({
        friends: Array.isArray(data.friends) ? data.friends : [],
        incoming: Array.isArray(data.incoming) ? data.incoming : [],
        outgoing: Array.isArray(data.outgoing) ? data.outgoing : [],
        ...(data.activeMatch ? { activeMatch: data.activeMatch } : {}),
      });
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

  useEffect(() => {
    const match = network.activeMatch;
    if (!match || pendingIncoming || joinedMatchId === match.matchId) return;
    const currentPlayer: PlayerSummary = {
      playerId: user?.id ?? '',
      displayName: user?.username || user?.fullName || 'Zulu Casino player',
      username: user?.username ?? null,
      imageUrl: user?.imageUrl ?? '',
    };
    void onJoinMatch({
      ...match,
      participants: match.participants ?? [currentPlayer, match.opponent],
      mode: match.mode ?? 'classic-1v1',
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : 'The accepted match could not be opened yet.');
    });
  }, [joinedMatchId, network.activeMatch, onJoinMatch, pendingIncoming, user]);

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

  function toggleTablePlayer(playerId: string) {
    if (selectedTablePlayerIds.includes(playerId)) {
      const next = selectedTablePlayerIds.filter((id) => id !== playerId);
      if (next.length === 0) setTableMode('classic-1v1');
      else if (next.length === 2 && selectedTablePlayerIds.length === 3 && tableMode === 'partners-2v2') {
        setTableMode('three-hand-rush');
      }
      setSelectedTablePlayerIds(next);
      return;
    }
    if (selectedTablePlayerIds.length >= 3) return;
    const next = [...selectedTablePlayerIds, playerId];
    if (next.length === 2 && tableMode === 'classic-1v1') setTableMode('three-hand-rush');
    if (next.length === 3 && tableMode !== 'partners-2v2') setTableMode('partners-2v2');
    setSelectedTablePlayerIds(next);
  }

  function inviteToTable() {
    const requiredCount = playerCountForMode(tableMode) - 1;
    if (selectedTablePlayerIds.length !== requiredCount) {
      setMessage(`Select ${requiredCount} friend${requiredCount === 1 ? '' : 's'} for this table.`);
      return;
    }
    void run(async () => {
      if (tableMode === 'classic-1v1') {
        await api('/api/challenges', {
          method: 'POST',
          body: JSON.stringify({ action: 'sendChallenge', targetPlayerId: selectedTablePlayerIds[0] }),
        });
        setMessage('Classic 1v1 challenge sent. The table starts when they accept.');
      } else {
        await api('/api/challenges', {
          method: 'POST',
          body: JSON.stringify({ action: 'sendGroupChallenge', targetPlayerIds: selectedTablePlayerIds, mode: tableMode }),
        });
        setMessage(`${MODE_NAMES[tableMode]} invitations sent. The table starts when everyone accepts.`);
      }
      setSelectedTablePlayerIds([]);
    });
  }

  function respond(challengeRequest: Challenge, decision: 'accepted' | 'declined') {
    void run(async () => {
      const data = await api('/api/challenges', {
        method: 'POST',
        body: JSON.stringify({ action: 'respond', challengeId: challengeRequest.id, decision }),
      });
      if (decision === 'accepted' && data.ready && data.challenge?.matchId) {
        const participants = data.challenge.participants ?? [challengeRequest.from, {
          playerId: user?.id ?? '',
          displayName: user?.username || user?.fullName || 'Zulu Casino player',
          username: user?.username ?? null,
          imageUrl: user?.imageUrl ?? '',
        }];
        await onJoinMatch({
          matchId: data.challenge.matchId,
          opponent: challengeRequest.from,
          participants,
          mode: data.challenge.mode ?? 'classic-1v1',
        });
      }
      setMessage(decision === 'accepted'
        ? data.ready
          ? `Challenge accepted. ${challengeRequest.from.displayName} has been notified.`
          : 'Accepted. Waiting for the other invited player to respond.'
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
            <p>wants to play {MODE_NAMES[pendingIncoming.mode]}.</p>
          </div>
          <button className="account-button" disabled={busy} onClick={() => respond(pendingIncoming, 'accepted')}>Accept</button>
          <button className="secondary-button" disabled={busy} onClick={() => respond(pendingIncoming, 'declined')}>Decline</button>
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

            {network.friends.length > 0 && (
              <fieldset className="table-invite-controls" disabled={busy}>
                <legend>Set up a table</legend>
                <label htmlFor="table-mode">Mode</label>
                <select
                  id="table-mode"
                  value={tableMode}
                  onChange={(event) => {
                    setTableMode(event.target.value as GameMode);
                  }}
                >
                  {Object.entries(MODE_NAMES).map(([mode, label]) => (
                    <option key={mode} value={mode}>{label}</option>
                  ))}
                </select>
                <span>Select {playerCountForMode(tableMode) - 1} friend{playerCountForMode(tableMode) === 2 ? '' : 's'}. The deal begins after every invite is accepted.</span>
                <div className="table-player-choices">
                  {network.friends.map((friend) => (
                    <label key={friend.playerId}>
                      <input
                        type="checkbox"
                        checked={selectedTablePlayerIds.includes(friend.playerId)}
                        disabled={!selectedTablePlayerIds.includes(friend.playerId) && selectedTablePlayerIds.length >= 3}
                        onChange={() => toggleTablePlayer(friend.playerId)}
                      />
                      <span>{friend.displayName}</span>
                    </label>
                  ))}
                </div>
                <button
                  className="account-button"
                  disabled={selectedTablePlayerIds.length !== playerCountForMode(tableMode) - 1}
                  onClick={inviteToTable}
                >Send {MODE_NAMES[tableMode]} invites</button>
              </fieldset>
            )}

            {message && <p className="friends-message" role="status">{message}</p>}
          </section>
        </div>
      )}
    </>
  );
}
