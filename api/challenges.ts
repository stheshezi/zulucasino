import { createClerkClient, verifyToken, type User } from '@clerk/backend';
import type { VercelRequest, VercelResponse } from '@vercel/node';

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
  mode: 'classic-1v1';
  status: ChallengeStatus;
  createdAt: string;
  updatedAt: string;
  matchId?: string;
}

interface ActiveMatch {
  matchId: string;
  opponent: PlayerSummary;
  createdAt: string;
}

interface PlayerNetwork {
  friends: PlayerSummary[];
  challenges: Challenge[];
  activeMatch?: ActiveMatch;
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
      const matchId = decision === 'accepted' ? `match_${crypto.randomUUID()}` : undefined;
      const updated: Challenge = {
        ...existing,
        status: decision,
        updatedAt: new Date().toISOString(),
        ...(matchId ? { matchId } : {}),
      };
      const acceptedAt = new Date().toISOString();
      await Promise.all([
        writeNetwork(userId, {
          ...myNetwork,
          challenges: upsertChallenge(myNetwork.challenges, updated),
          ...(matchId ? { activeMatch: { matchId, opponent: existing.from, createdAt: acceptedAt } } : {}),
        }),
        writeNetwork(sender.id, {
          ...senderNetwork,
          challenges: upsertChallenge(senderNetwork.challenges, updated),
          ...(matchId ? { activeMatch: { matchId, opponent: existing.to, createdAt: acceptedAt } } : {}),
        }),
      ]);
      return response.status(200).json({ challenge: updated });
    }

    return response.status(400).json({ error: 'Unknown challenge action.' });
  } catch (error) {
    console.error('Challenge API error', error);
    return response.status(500).json({ error: 'The player network is temporarily unavailable.' });
  }
}
