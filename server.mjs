import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CAPACITY_ML = 1000;
const POUR_DURATION_MS = 3200;
const GUESS_DURATION_MS = 15000;
const MAX_BODY_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT_ASSETS = new Set(['/index.html', '/styles.css', '/app.js', '/favicon.svg']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send your request as application/json.');
  }
  const content = await new Promise((accept, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(new HttpError(413, 'That request is too large.'));
      else accept(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
  let body;
  try {
    body = JSON.parse(content);
  } catch {
    throw new HttpError(400, 'Send a valid JSON request.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Send a JSON object.');
  }
  return body;
}

function requirePlayerId(playerId) {
  if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) {
    throw new HttpError(400, 'A valid player ID is required. Refresh the page and try again.');
  }
  return playerId;
}

function cleanPlayerName(value) {
  if (value === undefined || value === null || value === '') return 'Guest';
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid player name.');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return 'Guest';
  if ([...name].length > 24) throw new HttpError(400, 'Keep your player name to 24 characters.');
  return name;
}

function rounded(value) {
  return Number(value.toFixed(4));
}

function summarize(attempts, playerId) {
  const playerAttempts = attempts.filter((attempt) => attempt.playerId === playerId);
  const scored = playerAttempts.filter((attempt) => !attempt.timedOut);
  return {
    roundsPlayed: playerAttempts.length,
    bestError: scored.length ? Math.min(...scored.map((attempt) => attempt.errorPercent)) : null,
    averageError: scored.length ? rounded(scored.reduce((total, attempt) => total + attempt.errorPercent, 0) / scored.length) : null,
  };
}

function buildLeaderboard(attempts) {
  const players = new Map();
  for (const attempt of attempts) {
    const player = players.get(attempt.playerId) || { roundsPlayed: 0, best: null, playerName: attempt.playerName };
    player.roundsPlayed += 1;
    player.playerName = attempt.playerName;
    if (!attempt.timedOut && (!player.best || attempt.errorPercent < player.best.errorPercent)) player.best = attempt;
    players.set(attempt.playerId, player);
  }
  return [...players.entries()]
    .filter(([, player]) => player.best)
    .map(([playerId, player]) => ({
      playerId,
      playerName: player.playerName,
      errorPercent: player.best.errorPercent,
      roundsPlayed: player.roundsPlayed,
      guessMl: player.best.guessMl,
      actualMl: player.best.actualMl,
      createdAt: player.best.createdAt,
    }))
    .sort((a, b) => a.errorPercent - b.errorPercent || a.createdAt.localeCompare(b.createdAt) || a.playerId.localeCompare(b.playerId))
    .slice(0, 8);
}

/** Create an isolated game server. Await this before calling server.listen(). */
export async function createGameServer({ dataDir = join(ROOT, 'data'), now = Date.now, random = Math.random } = {}) {
  const resolvedDataDir = resolve(dataDir);
  const attemptsPath = join(resolvedDataDir, 'attempts.json');
  let attempts = [];
  try {
    const saved = JSON.parse(await readFile(attemptsPath, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.attempts)) throw new Error('Unsupported saved guesses format.');
    attempts = saved.attempts;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read saved guesses: ${error.message}`, { cause: error });
  }
  const rounds = new Map();
  let mutationQueue = Promise.resolve();

  function mutate(operation) {
    const pending = mutationQueue.then(operation);
    mutationQueue = pending.catch(() => {});
    return pending;
  }

  async function persist(nextAttempts) {
    await mkdir(resolvedDataDir, { recursive: true });
    const temporaryPath = join(resolvedDataDir, `.attempts-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify({ version: 1, attempts: nextAttempts }, null, 2) + '\n', 'utf8');
    await rename(temporaryPath, attemptsPath);
  }

  async function handleApi(request, response, url) {
    if (url.pathname === '/api/session' && request.method === 'GET') {
      const playerId = requirePlayerId(url.searchParams.get('playerId'));
      sendJson(response, 200, {
        attempts: attempts.filter((attempt) => attempt.playerId === playerId).slice(-50).reverse(),
        leaderboard: buildLeaderboard(attempts),
        stats: summarize(attempts, playerId),
      });
      return;
    }

    if (request.method !== 'POST') throw new HttpError(405, 'That method is not supported.');
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) {
      throw new HttpError(403, 'Please play from this website.');
    }
    const body = await readJson(request);
    const playerId = requirePlayerId(body.playerId);

    if (url.pathname === '/api/rounds') {
      const currentTime = now();
      for (const [id, round] of rounds) {
        if (currentTime - round.deadline > 60 * 60 * 1000) rounds.delete(id);
      }
      const actualMl = 150 + Math.min(750, Math.max(0, Math.floor(random() * 751)));
      const round = {
        id: randomUUID(),
        playerId,
        actualMl,
        startsAt: currentTime + POUR_DURATION_MS,
        deadline: currentTime + POUR_DURATION_MS + GUESS_DURATION_MS,
        completed: false,
      };
      rounds.set(round.id, round);
      sendJson(response, 201, {
        id: round.id,
        fillRatio: actualMl / CAPACITY_ML,
        capacityMl: CAPACITY_ML,
        pourDurationMs: POUR_DURATION_MS,
        guessDurationMs: GUESS_DURATION_MS,
        serverNow: currentTime,
        startsAt: round.startsAt,
        deadline: round.deadline,
      });
      return;
    }

    if (url.pathname !== '/api/guesses') throw new HttpError(404, 'That game endpoint was not found.');
    if (typeof body.roundId !== 'string' || !UUID_PATTERN.test(body.roundId)) throw new HttpError(400, 'A valid round ID is required.');
    if (body.guessMl !== null && (typeof body.guessMl !== 'number' || !Number.isFinite(body.guessMl) || body.guessMl <= 0 || body.guessMl > 1000)) {
      throw new HttpError(400, 'Enter a guess greater than 0 and no more than 1,000 ml.');
    }
    const playerName = cleanPlayerName(body.playerName);
    const receivedAt = now();
    const result = await mutate(async () => {
      const round = rounds.get(body.roundId);
      if (!round) throw new HttpError(404, 'This round has expired. Start a fresh pour.');
      if (round.playerId !== playerId) throw new HttpError(403, 'This round belongs to another player.');
      if (round.completed) throw new HttpError(409, 'Your guess for this round has already been saved.');
      if (receivedAt < round.startsAt) throw new HttpError(409, 'Let the pour finish before making your guess.');
      if (body.guessMl === null && receivedAt < round.deadline) throw new HttpError(409, 'There is still time to make a guess.');

      const timedOut = receivedAt >= round.deadline;
      const guessMl = timedOut ? null : body.guessMl;
      const attempt = {
        id: randomUUID(),
        roundId: round.id,
        playerId,
        playerName,
        guessMl,
        actualMl: round.actualMl,
        cupCapacityMl: CAPACITY_ML,
        errorPercent: timedOut ? null : rounded(Math.abs(guessMl - round.actualMl) / round.actualMl * 100),
        timedOut,
        createdAt: new Date(receivedAt).toISOString(),
        elapsedMs: Math.min(GUESS_DURATION_MS, Math.max(0, receivedAt - round.startsAt)),
      };
      const nextAttempts = [...attempts, attempt];
      await persist(nextAttempts);
      attempts = nextAttempts;
      round.completed = true;
      return { attempt, stats: summarize(attempts, playerId), leaderboard: buildLeaderboard(attempts) };
    });
    sendJson(response, 201, result);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'That method is not supported.');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'That file path is not valid.');
      }
      if (pathname === '/') pathname = '/index.html';
      const assetExtension = extname(pathname).toLowerCase();
      const nestedAsset = pathname.startsWith('/assets/') && MIME_TYPES[assetExtension];
      if (!ROOT_ASSETS.has(pathname) && !nestedAsset) throw new HttpError(404, 'That page was not found.');
      const assetPath = resolve(ROOT, `.${pathname}`);
      const publicRoot = nestedAsset ? join(ROOT, 'assets') : ROOT;
      const publicPath = relative(publicRoot, assetPath);
      if (publicPath.startsWith('..') || isAbsolute(publicPath)) throw new HttpError(404, 'That file was not found.');
      let contents;
      try {
        contents = await readFile(assetPath);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new HttpError(404, 'That file was not found.');
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[assetExtension] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': contents.length,
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!response.headersSent) {
        if (!(error instanceof HttpError)) console.error('Game request failed:', error.message);
        sendJson(response, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.message : 'Could not save your round. Please try again.',
        });
      } else response.end();
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a number between 0 and 65535.');
  const hostname = process.env.HOST || '127.0.0.1';
  const server = await createGameServer();
  server.listen(port, hostname, () => {
    console.log(`Volumle is ready at http://${hostname}:${server.address().port}`);
  });
}
