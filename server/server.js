require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');
const url = require('url');

// --- Config ---
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8354275871:AAEfOWq8BK_MbVrFjFqspewji3d9tmxNp24';
const ALLOWED_USERS = new Set([
  'huricane1',
  'Integral_girl',
  'ttrhach',
  'karbonari',
  'Divan0911',
  'szbuc',
  'grixylaa',
  'faccc1less',
  'Stlr21Bm',
  'Kxmaruthebest',
  'meyiapir',
  't3hge',
  'masofita',
  'maria_art_psy',
]);

// --- Telegram auth validation ---
function validateTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calculatedHash !== hash) return null;

    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}
const DB_SAVE_INTERVAL_MS = 2000;

// --- Database ---
const dbUrl = process.env.DATABASE_URL;
const pool = dbUrl
  ? new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    })
  : null;

let dbReady = false;

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL not set, running without persistence');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Untitled',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS board_state (
        board_id TEXT PRIMARY KEY REFERENCES boards(id),
        nodes JSONB NOT NULL DEFAULT '{}',
        arrows JSONB NOT NULL DEFAULT '{}',
        strokes JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS board_snapshots (
        id SERIAL PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id),
        nodes JSONB NOT NULL DEFAULT '{}',
        arrows JSONB NOT NULL DEFAULT '{}',
        strokes JSONB NOT NULL DEFAULT '[]',
        node_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_board_time
      ON board_snapshots(board_id, created_at DESC);
    `);
    dbReady = true;
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// --- In-memory state ---
// boardId -> { nodes: {}, arrows: {}, strokes: [], dirty: bool }
const boardStates = new Map();
// boardId -> Set<ws>
const boardClients = new Map();
// ws -> { boardId, userId, color }
const clientInfo = new Map();

// --- Helpers ---
function generateId(len = 8) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function randomColor() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F1948A', '#82E0AA', '#F8C471', '#AED6F1', '#D7BDE2',
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

async function loadBoardState(boardId) {
  if (boardStates.has(boardId)) {
    return boardStates.get(boardId);
  }
  let state = { nodes: {}, arrows: {}, strokes: [], dirty: false };
  if (pool && dbReady) {
    try {
      const result = await pool.query(
        'SELECT nodes, arrows, strokes FROM board_state WHERE board_id = $1',
        [boardId]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        state = {
          nodes: row.nodes || {},
          arrows: row.arrows || {},
          strokes: row.strokes || [],
          dirty: false,
        };
      }
    } catch (err) {
      console.error(`Failed to load board ${boardId}:`, err.message);
    }
  }
  boardStates.set(boardId, state);
  return state;
}

async function saveBoardState(boardId) {
  const state = boardStates.get(boardId);
  if (!state || !state.dirty || !pool || !dbReady) return;

  try {
    await pool.query(
      `INSERT INTO board_state (board_id, nodes, arrows, strokes, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (board_id) DO UPDATE
       SET nodes = $2, arrows = $3, strokes = $4, updated_at = NOW()`,
      [boardId, JSON.stringify(state.nodes), JSON.stringify(state.arrows), JSON.stringify(state.strokes)]
    );
    await pool.query(
      'UPDATE boards SET updated_at = NOW() WHERE id = $1',
      [boardId]
    );
    state.dirty = false;
  } catch (err) {
    console.error(`Failed to save board ${boardId}:`, err.message);
  }
}

// --- Snapshots: auto-save every 5 minutes if board changed ---
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS_PER_BOARD = 50;
const lastSnapshotHash = new Map(); // boardId -> JSON hash of last snapshot

function stateHash(state) {
  // Quick hash: count nodes + first node text + arrow count
  const nk = Object.keys(state.nodes);
  return `${nk.length}:${nk[0] || ''}:${Object.keys(state.arrows).length}:${(state.strokes || []).length}`;
}

async function saveSnapshot(boardId) {
  if (!pool || !dbReady) return;
  const state = boardStates.get(boardId);
  if (!state) return;

  const hash = stateHash(state);
  if (lastSnapshotHash.get(boardId) === hash) return; // no change
  if (Object.keys(state.nodes).length === 0 && (state.strokes || []).length === 0) return; // empty board

  try {
    await pool.query(
      `INSERT INTO board_snapshots (board_id, nodes, arrows, strokes, node_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [boardId, JSON.stringify(state.nodes), JSON.stringify(state.arrows),
       JSON.stringify(state.strokes), Object.keys(state.nodes).length]
    );
    lastSnapshotHash.set(boardId, hash);

    // Trim old snapshots
    await pool.query(
      `DELETE FROM board_snapshots WHERE board_id = $1 AND id NOT IN (
        SELECT id FROM board_snapshots WHERE board_id = $1 ORDER BY created_at DESC LIMIT $2
      )`,
      [boardId, MAX_SNAPSHOTS_PER_BOARD]
    );
    console.log(`Snapshot saved for board ${boardId}`);
  } catch (err) {
    console.error(`Snapshot failed for ${boardId}:`, err.message);
  }
}

const snapshotInterval = setInterval(async () => {
  for (const boardId of boardStates.keys()) {
    await saveSnapshot(boardId);
  }
}, SNAPSHOT_INTERVAL_MS);

// Debounced save: flush all dirty boards every 2 seconds
const saveInterval = setInterval(async () => {
  for (const [boardId, state] of boardStates) {
    if (state.dirty) {
      await saveBoardState(boardId);
    }
  }
}, DB_SAVE_INTERVAL_MS);

function broadcast(boardId, message, excludeWs) {
  const clients = boardClients.get(boardId);
  if (!clients) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function applyDelta(state, msg) {
  switch (msg.type) {
    case 'node:add':
      if (msg.node && msg.node.id) {
        state.nodes[msg.node.id] = msg.node;
        state.dirty = true;
      }
      break;

    case 'node:update':
      if (msg.id && state.nodes[msg.id]) {
        Object.assign(state.nodes[msg.id], msg.updates);
        state.dirty = true;
      }
      break;

    case 'node:delete':
      if (msg.id && state.nodes[msg.id]) {
        delete state.nodes[msg.id];
        state.dirty = true;
      }
      break;

    case 'arrow:add':
      if (msg.arrow && msg.arrow.id) {
        state.arrows[msg.arrow.id] = msg.arrow;
        state.dirty = true;
      }
      break;

    case 'arrow:update':
      if (msg.id && state.arrows[msg.id]) {
        Object.assign(state.arrows[msg.id], msg.updates);
        state.dirty = true;
      }
      break;

    case 'arrow:delete':
      if (msg.id && state.arrows[msg.id]) {
        delete state.arrows[msg.id];
        state.dirty = true;
      }
      break;

    case 'stroke:add':
      if (msg.stroke) {
        state.strokes.push(msg.stroke);
        state.dirty = true;
      }
      break;

    case 'stroke:delete':
      if (msg.id) {
        state.strokes = state.strokes.filter(s => s.id !== msg.id);
        state.dirty = true;
      }
      break;

    case 'stroke:pixel-erase':
      if (Array.isArray(msg.deletedIds)) {
        const deleteSet = new Set(msg.deletedIds);
        state.strokes = state.strokes.filter(s => !deleteSet.has(s.id));
      }
      if (Array.isArray(msg.newStrokes)) {
        state.strokes.push(...msg.newStrokes);
      }
      state.dirty = true;
      break;

    case 'erase:objects': {
      const nIds = new Set(msg.nodeIds || []);
      const aIds = new Set(msg.arrowIds || []);
      const sIds = new Set(msg.strokeIds || []);
      for (const id of nIds) delete state.nodes[id];
      for (const [aId, a] of Object.entries(state.arrows)) {
        if (aIds.has(aId) || nIds.has(a.fromNodeId) || nIds.has(a.toNodeId)) delete state.arrows[aId];
      }
      state.strokes = state.strokes.filter(s => !sIds.has(s.id));
      state.dirty = true;
      break;
    }

    case 'state:undo':
      if (msg.state) {
        state.nodes = msg.state.nodes || {};
        state.arrows = msg.state.arrows || {};
        state.strokes = msg.state.strokes || [];
        state.dirty = true;
      }
      break;

    // cursor messages are broadcast-only, no state mutation
    case 'cursor':
      break;

    default:
      console.warn('Unknown message type:', msg.type);
  }
}

// --- Express app ---
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth', (req, res) => {
  const { initData } = req.body;
  if (!initData) return res.status(400).json({ ok: false, error: 'No initData' });

  const user = validateTelegramData(initData);
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid signature' });

  if (!ALLOWED_USERS.has(user.username)) {
    return res.status(403).json({ ok: false, error: 'Not in whitelist' });
  }

  res.json({ ok: true, user: { id: user.id, username: user.username, firstName: user.first_name } });
});

app.get('/api/boards', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, created_at, updated_at FROM boards ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to list boards:', err.message);
    res.status(500).json({ error: 'Failed to list boards' });
  }
});

app.post('/api/boards', async (req, res) => {
  const id = generateId();
  const name = req.body?.name || 'Untitled';
  try {
    await pool.query(
      'INSERT INTO boards (id, name) VALUES ($1, $2)',
      [id, name]
    );
    await pool.query(
      'INSERT INTO board_state (board_id) VALUES ($1)',
      [id]
    );
    res.status(201).json({ id, name });
  } catch (err) {
    console.error('Failed to create board:', err.message);
    res.status(500).json({ error: 'Failed to create board' });
  }
});

app.get('/api/boards/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const boardResult = await pool.query(
      'SELECT id, name FROM boards WHERE id = $1',
      [id]
    );
    if (boardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Board not found' });
    }
    const state = await loadBoardState(id);
    res.json({
      id: boardResult.rows[0].id,
      name: boardResult.rows[0].name,
      nodes: state.nodes,
      arrows: state.arrows,
      strokes: state.strokes,
    });
  } catch (err) {
    console.error('Failed to get board:', err.message);
    res.status(500).json({ error: 'Failed to get board' });
  }
});

/* ================================================================
   Snapshot API — version history
   ================================================================ */

// List snapshots for a board
app.get('/api/boards/:id/snapshots', async (req, res) => {
  const { id } = req.params;
  if (!pool || !dbReady) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT id, node_count, created_at FROM board_snapshots
       WHERE board_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a snapshot
app.post('/api/boards/:id/snapshots/:snapshotId/restore', async (req, res) => {
  const { id, snapshotId } = req.params;
  if (!pool || !dbReady) return res.status(503).json({ error: 'DB not available' });
  try {
    // Save current state as snapshot before restoring (safety net)
    await saveSnapshot(id);

    const result = await pool.query(
      'SELECT nodes, arrows, strokes FROM board_snapshots WHERE id = $1 AND board_id = $2',
      [snapshotId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Snapshot not found' });

    const snap = result.rows[0];
    const state = boardStates.get(id) || { nodes: {}, arrows: {}, strokes: [], dirty: false };
    state.nodes = snap.nodes || {};
    state.arrows = snap.arrows || {};
    state.strokes = snap.strokes || [];
    state.dirty = true;
    boardStates.set(id, state);

    // Save immediately
    await saveBoardState(id);

    // Broadcast to all connected clients
    broadcast(id, { type: 'state:undo', state: { nodes: state.nodes, arrows: state.arrows, strokes: state.strokes } });

    res.json({ ok: true, nodeCount: Object.keys(state.nodes).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   Bot-friendly read-only API (for Albert to query via WebFetch)
   Returns compact JSON to minimize context usage.
   ================================================================ */

// Search nodes by text (case-insensitive substring match)
app.get('/api/boards/:id/search', async (req, res) => {
  const { id } = req.params;
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  try {
    const state = await loadBoardState(id);
    const results = Object.values(state.nodes)
      .filter(n => n.text && n.text.toLowerCase().includes(q))
      .map(n => ({ id: n.id, text: n.text, x: n.x, y: n.y }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get N most recently added nodes (by ID sort — IDs are time-based)
app.get('/api/boards/:id/recent', async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const state = await loadBoardState(id);
    const sorted = Object.values(state.nodes)
      .sort((a, b) => (b.id || '').localeCompare(a.id || ''))
      .slice(0, limit)
      .map(n => ({ id: n.id, text: n.text }));
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compact graph: node names + connections (no coordinates, no strokes)
app.get('/api/boards/:id/graph', async (req, res) => {
  const { id } = req.params;
  try {
    const state = await loadBoardState(id);
    const nodes = Object.values(state.nodes).map(n => ({
      id: n.id,
      text: n.text || '(empty)',
    }));
    const edges = Object.values(state.arrows).map(a => ({
      from: state.nodes[a.fromNodeId]?.text || a.fromNodeId,
      to: state.nodes[a.toNodeId]?.text || a.toNodeId,
      ...(a.label ? { label: a.label } : {}),
    }));
    res.json({ nodes, edges, nodeCount: nodes.length, edgeCount: edges.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP + WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  const match = pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  request.boardId = match[1];
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', async (ws, request) => {
  const boardId = request.boardId;
  const userId = generateId();
  const color = randomColor();

  // Verify board exists (or auto-create)
  if (pool && dbReady) {
    try {
      const exists = await pool.query('SELECT id FROM boards WHERE id = $1', [boardId]);
      if (exists.rows.length === 0) {
        await pool.query('INSERT INTO boards (id, name) VALUES ($1, $2)', [boardId, 'Untitled']);
        await pool.query('INSERT INTO board_state (board_id) VALUES ($1)', [boardId]);
      }
    } catch (err) {
      console.error(`Board verify/create failed (continuing without DB):`, err.message);
    }
  }

  // Track connection
  if (!boardClients.has(boardId)) {
    boardClients.set(boardId, new Set());
  }
  boardClients.get(boardId).add(ws);
  clientInfo.set(ws, { boardId, userId, color });

  console.log(`[${boardId}] User ${userId} connected (${boardClients.get(boardId).size} clients)`);

  // Send initial state
  try {
    const state = await loadBoardState(boardId);
    ws.send(JSON.stringify({
      type: 'init',
      state: { nodes: state.nodes, arrows: state.arrows, strokes: state.strokes },
    }));
  } catch (err) {
    console.error(`Failed to load state for board ${boardId}:`, err.message);
  }

  // Send current users list to the new client
  const users = [];
  for (const client of boardClients.get(boardId)) {
    const info = clientInfo.get(client);
    if (info) {
      users.push({ userId: info.userId, color: info.color });
    }
  }
  ws.send(JSON.stringify({ type: 'users', users }));

  // Announce join to others
  broadcast(boardId, { type: 'user:join', userId, color }, ws);

  // Handle messages
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn(`[${boardId}] Invalid JSON from ${userId}`);
      return;
    }

    // Apply delta to in-memory state
    try {
      const state = await loadBoardState(boardId);
      applyDelta(state, msg);
    } catch (err) {
      console.error(`[${boardId}] Failed to apply delta:`, err.message);
    }

    // Broadcast to other clients in the same board
    broadcast(boardId, msg, ws);
  });

  // Handle disconnect
  ws.on('close', () => {
    const info = clientInfo.get(ws);
    if (info) {
      const clients = boardClients.get(info.boardId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          boardClients.delete(info.boardId);
          // Flush state to DB before forgetting it
          saveBoardState(info.boardId).then(() => {
            boardStates.delete(info.boardId);
          });
        }
      }
      broadcast(info.boardId, { type: 'user:leave', userId: info.userId });
      console.log(`[${info.boardId}] User ${info.userId} disconnected (${clients?.size ?? 0} clients)`);
    }
    clientInfo.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`[${boardId}] WebSocket error for ${userId}:`, err.message);
  });
});

// --- Graceful shutdown ---
async function shutdown() {
  console.log('Shutting down...');

  clearInterval(saveInterval);

  // Save all dirty boards
  for (const [boardId, state] of boardStates) {
    if (state.dirty) {
      await saveBoardState(boardId);
    }
  }

  // Close all WebSocket connections
  for (const [, clients] of boardClients) {
    for (const ws of clients) {
      ws.close(1001, 'Server shutting down');
    }
  }

  wss.close();

  server.close(() => {
    pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --- Start ---
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Whiteboard server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database init failed (will start without persistence):', err.message);
    // Start anyway — boards work in-memory
    server.listen(PORT, () => {
      console.log(`Whiteboard server running on port ${PORT} (no DB)`);
    });
  });
