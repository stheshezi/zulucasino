import { createClerkClient, verifyToken, type User } from '@clerk/backend';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { GameMode } from '../src/game/index.js';
import {
  acceptMatchLobbyPlayer,
  cancelMatchLobby,
  createMatchLobby,
  ensureMatchRecord,
  expectedPlayersForMode,
  isMatchComplete,
} from './match-store.js';

type ChallengeStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

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
  status: ChallengeStatus;
  createdAt: string;
  updatedAt: string;
  matchId?: string;
  participants?: PlayerSummary[];
}

interface ActiveMatch {
  matchId: string;
  opponent: PlayerSummary;
  participants?: PlayerSummary[];
  mode: GameMode;
  createdAt: string;
  status: 'ready';
}

export interface PlayerNetwork {
  friends: PlayerSummary[];
  challenges: Challenge[];
  activeMatch?: ActiveMatch;
}

export function clearMatchingActiveMatch(network: PlayerNetwork, matchId: string): PlayerNetwork | null {
  if (!network.activeMatch || network.activeMatch.matchId !== matchId) return null;
  const { activeMatch: _activeMatch, ...remainingNetwork } = network;
  return remainingNetwork;
}

const NETWORK_KEY = 'zuluCasinoNetwork';
const CHALLENGE_LIFETIME_MS = 15 * 60 * 1000;

function clerk() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured.');
  return createClerkClient({ secretKey });
}

function playerSummary(user: User): PlayerSummary {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return {
    playerId: user.id,
    displayName: user.username || name || 'Zulu Casino Player',
    username: user.username,
    imageUrl: user.imageUrl,
  };
}

function readNetwork(user: User): PlayerNetwork {
  const value = user.privateMetadata[NETWORK_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { friends: [], challenges: [] };
  }
  const network = value as unknown as Partial<PlayerNetwork>;
  return {
    friends: Array.isArray(network.friends) ? network.friends : [],
    challenges: Array.isArray(network.challenges) ? network.challenges : [],
    ...(network.activeMatch ? { activeMatch: network.activeMatch } : {}),
  };
}

async function writeNetwork(userId: string, network: PlayerNetwork) {
  await clerk().users.updateUserMetadata(userId, {
    privateMetadata: { [NETWORK_KEY]: network },
  });
}

async function authenticatedUserId(request: VercelRequest) {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return null;
  const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
  return payload.sub;
}

function cleanChallenges(challenges: Challenge[]) {
  const now = Date.now();
  return challenges.filter((challenge) => (
    challenge.status !== 'pending' || now - Date.parse(challenge.createdAt) < CHALLENGE_LIFETIME_MS
  )).slice(-40);
}

function upsertChallenge(challenges: Challenge[], challenge: Challenge) {
  return [...challenges.filter((item) => item.id !== challenge.id), challenge].slice(-40);
}

function upsertFriend(friends: PlayerSummary[], friend: PlayerSummary) {
  return [...friends.filter((item) => item.playerId !== friend.playerId), friend];
}

async function findPlayer(targetPlayerId: string) {
  if (!targetPlayerId.startsWith('user_')) return null;
  try {
    return await clerk().users.getUser(targetPlayerId);
  } catch {
    return null;
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  try {
    const userId = await authenticatedUserId(request);
    if (!userId) return response.status(401).json({ error: 'Sign in to use player challenges.' });

    const client = clerk();
    const currentUser = await client.users.getUser(userId);

    if (request.method === 'GET') {
      const query = typeof request.query.query === 'string' ? request.query.query.trim() : '';
      if (query) {
        const result = query.startsWith('user_')
          ? await findPlayer(query).then((user) => ({ data: user ? [user] : [] }))
          : await client.users.getUserList({ query, limit: 12 });
        const players = result.data
          .filter((user) => user.id !== userId)
          .map(playerSummary)
          .slice(0, 8);
        return response.status(200).json({ players });
      }

      const network = readNetwork(currentUser);
      network.challenges = cleanChallenges(network.challenges);
      const incoming = network.challenges.filter((challenge) => challenge.to.playerId === userId);
      const outgoing = network.challenges.filter((challenge) => challenge.from.playerId === userId);
      return response.status(200).json({ ...network, incoming, outgoing });
    }

    if (request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      return response.status(405).json({ error: 'Method not allowed.' });
    }

    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    const action = body?.action as string | undefined;

    if (action === 'leaveMatch') {
      const matchId = String(body.matchId ?? '');
      const network = readNetwork(currentUser);
      const clearedNetwork = clearMatchingActiveMatch(network, matchId);
      if (!clearedNetwork) return response.status(404).json({ error: 'That is not your active table.' });
      if (!await isMatchComplete(matchId)) {
        return response.status(409).json({ error: 'Finish the game before leaving this table.' });
      }
      await writeNetwork(userId, clearedNetwork);
      return response.status(200).json({ left: true });
    }

    if (action === 'addFriend') {
      const target = await findPlayer(String(body.targetPlayerId ?? ''));
      if (!target || target.id === userId) return response.status(404).json({ error: 'Player not found.' });
      const me = playerSummary(currentUser);
      const them = playerSummary(target);
      const myNetwork = readNetwork(currentUser);
      const theirNetwork = readNetwork(target);
      await Promise.all([
        writeNetwork(userId, { ...myNetwork, friends: upsertFriend(myNetwork.friends, them) }),
        writeNetwork(target.id, { ...theirNetwork, friends: upsertFriend(theirNetwork.friends, me) }),
      ]);
      return response.status(200).json({ friend: them });
    }

    if (action === 'sendChallenge') {
      const target = await findPlayer(String(body.targetPlayerId ?? ''));
      if (!target || target.id === userId) return response.status(404).json({ error: 'Player not found.' });
      const myNetwork = readNetwork(currentUser);
      const theirNetwork = readNetwork(target);
      const duplicate = cleanChallenges(myNetwork.challenges).find((challenge) => (
        challenge.status === 'pending' && challenge.to.playerId === target.id
      ));
      if (duplicate) return response.status(409).json({ error: 'A challenge is already waiting for this player.' });

      const now = new Date().toISOString();
      const challenge: Challenge = {
        id: `challenge_${crypto.randomUUID()}`,
        from: playerSummary(currentUser),
        to: playerSummary(target),
        mode: 'classic-1v1',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      await Promise.all([
        writeNetwork(userId, { ...myNetwork, challenges: upsertChallenge(cleanChallenges(myNetwork.challenges), challenge) }),
        writeNetwork(target.id, { ...theirNetwork, challenges: upsertChallenge(cleanChallenges(theirNetwork.challenges), challenge) }),
      ]);
      return response.status(201).json({ challenge });
    }

    if (action === 'sendGroupChallenge') {
      const mode = body.mode === 'three-hand-qualifier' || body.mode === 'partners-2v2'
        ? body.mode as GameMode
        : 'three-hand-rush';
      const targetPlayerIds = Array.isArray(body.targetPlayerIds)
        ? [...new Set(body.targetPlayerIds.map(String))]
        : [];
      const inviteCount = expectedPlayersForMode(mode) - 1;
      if (targetPlayerIds.length !== inviteCount || targetPlayerIds.includes(userId)) {
        return response.status(400).json({ error: `Choose exactly ${inviteCount} other players for this table.` });
      }
      const targets = await Promise.all(targetPlayerIds.map(findPlayer));
      if (targets.some((target) => !target)) return response.status(404).json({ error: 'One or more players could not be found.' });
      const players = [playerSummary(currentUser), ...targets.map((target) => playerSummary(target!))];
      const targetUsers = targets as User[];
      const targetNetworks = targetUsers.map(readNetwork);
      if (targetNetworks.some((network) => network.activeMatch)) {
        return response.status(409).json({ error: 'One of those players is already in a table.' });
      }

      const myNetwork = readNetwork(currentUser);
      const matchId = `match_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const challenges = targetUsers.map((target) => ({
        id: `challenge_${crypto.randomUUID()}`,
        from: playerSummary(currentUser),
        to: playerSummary(target),
        mode,
        status: 'pending' as const,
        createdAt: now,
        updatedAt: now,
        matchId,
        participants: players,
      }));
      await createMatchLobby(matchId, players, mode, userId);
      await Promise.all([
        writeNetwork(userId, {
          ...myNetwork,
          challenges: challenges.reduce((items, challenge) => upsertChallenge(items, challenge), myNetwork.challenges),
        }),
        ...targetUsers.map((target, index) => writeNetwork(target.id, {
          ...targetNetworks[index],
          challenges: upsertChallenge(targetNetworks[index].challenges, challenges[index]),
        })),
      ]);
      return response.status(201).json({ matchId, mode, players, challenges });
    }

    if (action === 'respond') {
      const challengeId = String(body.challengeId ?? '');
      const decision = body.decision === 'accepted' ? 'accepted' : body.decision === 'declined' ? 'declined' : null;
      const myNetwork = readNetwork(currentUser);
      const existing = myNetwork.challenges.find((challenge) => challenge.id === challengeId);
      if (!existing || existing.to.playerId !== userId || existing.status !== 'pending') {
        return response.status(404).json({ error: 'This challenge is no longer available.' });
      }
      if (!decision) return response.status(400).json({ error: 'Choose accept or decline.' });

      const sender = await findPlayer(existing.from.playerId);
      if (!sender) return response.status(404).json({ error: 'The challenging player is no longer available.' });
      const senderNetwork = readNetwork(sender);
      const groupedChallenge = existing.mode !== 'classic-1v1';
      const matchId = decision === 'accepted'
        ? existing.matchId ?? `match_${crypto.randomUUID()}`
        : existing.matchId;
      const updated: Challenge = {
        ...existing,
        status: decision,
        updatedAt: new Date().toISOString(),
        ...(matchId ? { matchId } : {}),
      };
      const acceptedAt = new Date().toISOString();
      const updatedSenderChallenges = upsertChallenge(senderNetwork.challenges, updated);
      if (groupedChallenge && (!matchId || existing.participants?.length !== expectedPlayersForMode(existing.mode))) {
        return response.status(409).json({ error: 'This table invitation has an invalid player roster.' });
      }
      if (groupedChallenge && matchId && existing.participants?.length === expectedPlayersForMode(existing.mode)) {
        const lobbyAcceptance = decision === 'accepted'
          ? await acceptMatchLobbyPlayer(matchId, userId)
          : null;
        if (decision === 'declined') await cancelMatchLobby(matchId);
        if (decision === 'accepted' && !lobbyAcceptance) {
          return response.status(409).json({ error: 'This table lobby is no longer waiting for players.' });
        }
        if (decision === 'accepted' && !lobbyAcceptance!.ready) {
          await Promise.all([
            writeNetwork(userId, { ...myNetwork, challenges: upsertChallenge(myNetwork.challenges, updated) }),
            writeNetwork(sender.id, { ...senderNetwork, challenges: updatedSenderChallenges }),
          ]);
          return response.status(200).json({
            challenge: updated,
            ready: false,
            waitingFor: expectedPlayersForMode(existing.mode) - lobbyAcceptance!.acceptedCount,
          });
        }
        if (decision === 'declined') {
          const declinedParticipants = await Promise.all(existing.participants.map(async (participant) => {
            if (participant.playerId === currentUser.id) return currentUser;
            if (participant.playerId === sender.id) return sender;
            const player = await findPlayer(participant.playerId);
            if (!player) throw new Error('A table invitee is no longer available.');
            return player;
          }));
          await Promise.all(declinedParticipants.map((participant) => {
            const participantNetwork = participant.id === currentUser.id
              ? myNetwork
              : participant.id === sender.id ? senderNetwork : readNetwork(participant);
            const challenges = upsertChallenge(participantNetwork.challenges, updated)
              .map((challenge) => challenge.matchId === matchId && challenge.status === 'pending'
                ? { ...challenge, status: 'cancelled' as const, updatedAt: acceptedAt }
                : challenge);
            return writeNetwork(participant.id, { ...participantNetwork, challenges });
          }));
          return response.status(200).json({ challenge: updated, ready: false });
        }

        const participants = existing.participants;
        const participantUsers = await Promise.all(participants.map(async (participant) => {
          if (participant.playerId === currentUser.id) return currentUser;
          if (participant.playerId === sender.id) return sender;
          const user = await findPlayer(participant.playerId);
          if (!user) throw new Error('A 3-Hand player is no longer available.');
          return user;
        }));
        await ensureMatchRecord(matchId, participants, existing.mode);
        await Promise.all(participantUsers.map((participant) => {
          const existingNetwork = participant.id === currentUser.id
            ? { ...myNetwork, challenges: upsertChallenge(myNetwork.challenges, updated) }
            : participant.id === sender.id
              ? { ...senderNetwork, challenges: updatedSenderChallenges }
              : readNetwork(participant);
          const opponents = participants.filter((entry) => entry.playerId !== participant.id);
          return writeNetwork(participant.id, {
            ...existingNetwork,
            challenges: existingNetwork.challenges.map((challenge) => (
              challenge.matchId === matchId ? { ...challenge, status: 'accepted', updatedAt: acceptedAt } : challenge
            )),
            activeMatch: {
              matchId,
              opponent: opponents[0],
              participants,
              mode: existing.mode,
              createdAt: acceptedAt,
              status: 'ready',
            },
          });
        }));
        return response.status(200).json({ challenge: updated, ready: true, matchId });
      }

      if (decision === 'accepted' && matchId) {
        const [playerOne, playerTwo] = [currentUser, sender]
          .sort((first, second) => first.id.localeCompare(second.id));
        await ensureMatchRecord(matchId, [playerSummary(playerOne), playerSummary(playerTwo)], 'classic-1v1');
      }
      await Promise.all([
        writeNetwork(userId, {
          ...myNetwork,
          challenges: upsertChallenge(myNetwork.challenges, updated),
          ...(decision === 'accepted' && matchId ? { activeMatch: {
            matchId, opponent: existing.from, participants: [existing.to, existing.from],
            mode: 'classic-1v1' as const, createdAt: acceptedAt, status: 'ready' as const,
          } } : {}),
        }),
        writeNetwork(sender.id, {
          ...senderNetwork,
          challenges: updatedSenderChallenges,
          ...(decision === 'accepted' && matchId ? { activeMatch: {
            matchId, opponent: existing.to, participants: [existing.from, existing.to],
            mode: 'classic-1v1' as const, createdAt: acceptedAt, status: 'ready' as const,
          } } : {}),
        }),
      ]);
      return response.status(200).json({ challenge: updated, ready: decision === 'accepted', matchId });
    }

    return response.status(400).json({ error: 'Unknown challenge action.' });
  } catch (error) {
    console.error('Challenge API error', error);
    return response.status(500).json({ error: 'The player network is temporarily unavailable.' });
  }
}
