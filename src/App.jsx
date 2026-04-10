import { useState, useCallback, useEffect, useRef } from 'react';
import Canvas from './Canvas.jsx';
import useSync from './useSync.js';
import useTelegramAuth from './useTelegramAuth.js';
import LoginPage from './LoginPage.jsx';

/* ================================================================
   Mobile detection hook
   ================================================================ */
function useMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

/* ================================================================
   Constants
   ================================================================ */
function storageKey(boardId) { return `whiteboard-data-${boardId}`; }
const SAVE_DEBOUNCE = 500;
const MAX_HISTORY = 50;
const SERVER_URL = 'https://whiteboard-production-ec19.up.railway.app';

// Boards are loaded from the server per-user (no more hardcoded list)

function getBoardId() {
  const hash = window.location.hash.slice(1);
  if (hash && hash.length >= 4) return hash;
  return null; // no default — let the app decide after auth
}
const PALETTE = [
  '#6c8cff', '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9',
  '#4dabf7', '#da77f2', '#f783ac', '#e8590c', '#ffffff', '#868e96',
];

let nextId = 1;
function genId(prefix = 'n') {
  return prefix + (nextId++) + '_' + Date.now().toString(36);
}

/* ================================================================
   Load persisted state
   ================================================================ */
function loadState(bid) {
  try {
    const raw = localStorage.getItem(storageKey(bid));
    if (raw) {
      const parsed = JSON.parse(raw);
      // Bump nextId past any existing IDs
      const allIds = [
        ...Object.keys(parsed.nodes || {}),
        ...Object.keys(parsed.arrows || {}),
        ...(parsed.strokes || []).map(s => s.id).filter(Boolean),
      ];
      for (const id of allIds) {
        const m = id.match(/^[nas](\d+)/);
        if (m) nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
      }
      // Migrate strokes without IDs
      const strokes = (parsed.strokes || []).map(s => {
        if (!s.id) return { ...s, id: genId('s') };
        return s;
      });
      return {
        nodes: parsed.nodes || {},
        arrows: parsed.arrows || {},
        viewport: parsed.viewport || { panX: 0, panY: 0, zoom: 1 },
        strokes,
      };
    }
  } catch {
    // Corrupted storage, start fresh
  }
  return null;
}

function defaultState() {
  const id = genId();
  return {
    nodes: {
      [id]: { id, x: 200, y: 200, text: 'Welcome to your whiteboard!', color: '#6c8cff', width: 220 },
    },
    arrows: {},
    strokes: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
  };
}

/* ================================================================
   History snapshot helpers
   ================================================================ */
function takeSnapshot(state) {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)),
    arrows: JSON.parse(JSON.stringify(state.arrows)),
    strokes: JSON.parse(JSON.stringify(state.strokes || [])),
  };
}

function applySnapshot(state, snapshot) {
  return {
    ...state,
    nodes: snapshot.nodes,
    arrows: snapshot.arrows,
    strokes: snapshot.strokes,
  };
}

/* ================================================================
   Members panel — shown as overlay for board owners
   ================================================================ */
function MembersPanel({ boardId, authToken }) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState([]);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [status, setStatus] = useState(null); // { type: 'ok'|'err', msg }

  const loadMembers = useCallback(() => {
    fetch(`${SERVER_URL}/api/boards/${boardId}/members`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setMembers(data); });
  }, [boardId, authToken]);

  useEffect(() => { if (open) loadMembers(); }, [open, loadMembers]);

  async function handleInvite() {
    const name = inviteUsername.trim().replace(/^@/, '');
    if (!name) return;
    setStatus(null);
    const res = await fetch(`${SERVER_URL}/api/boards/${boardId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ username: name, role: inviteRole }),
    });
    const data = await res.json();
    if (data.ok) {
      setStatus({ type: 'ok', msg: `${name} added as ${data.role}` });
      setInviteUsername('');
      loadMembers();
    } else {
      setStatus({ type: 'err', msg: data.error || 'Failed' });
    }
  }

  async function handleRemove(username) {
    if (!confirm(`Remove ${username} from this board?`)) return;
    await fetch(`${SERVER_URL}/api/boards/${boardId}/members/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    loadMembers();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', top: 10, right: 10, zIndex: 1000,
          padding: '6px 12px', background: '#2a2a4a', color: '#aaa',
          border: '1px solid #3a3a5a', borderRadius: '8px', cursor: 'pointer',
          fontSize: '0.8rem',
        }}
      >
        Members
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', top: 10, right: 10, zIndex: 1000,
      width: '260px', background: '#1e1e36', border: '1px solid #3a3a5a',
      borderRadius: '10px', padding: '12px', color: '#e0e0e0',
      fontSize: '0.85rem', boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <b>Members</b>
        <button onClick={() => setOpen(false)} style={{
          background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '1rem',
        }}>×</button>
      </div>

      {members.map(m => (
        <div key={m.username} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '4px 0', borderBottom: '1px solid #2a2a4a',
        }}>
          <span>{m.username} <span style={{ color: '#666', fontSize: '0.75rem' }}>({m.role})</span></span>
          {m.role !== 'owner' && (
            <button onClick={() => handleRemove(m.username)} style={{
              background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: '0.75rem',
            }}>remove</button>
          )}
        </div>
      ))}

      <div style={{ marginTop: '10px', display: 'flex', gap: '4px' }}>
        <input
          placeholder="@username"
          value={inviteUsername}
          onChange={e => setInviteUsername(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleInvite()}
          style={{
            flex: 1, padding: '6px', background: '#2a2a4a', color: '#e0e0e0',
            border: '1px solid #3a3a5a', borderRadius: '6px', fontSize: '0.8rem', outline: 'none',
          }}
        />
        <select
          value={inviteRole}
          onChange={e => setInviteRole(e.target.value)}
          style={{
            padding: '4px', background: '#2a2a4a', color: '#e0e0e0',
            border: '1px solid #3a3a5a', borderRadius: '6px', fontSize: '0.75rem',
          }}
        >
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
        <button onClick={handleInvite} style={{
          padding: '4px 8px', background: '#6c8cff', color: 'white',
          border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
        }}>+</button>
      </div>
      {status && (
        <div style={{ marginTop: '6px', color: status.type === 'ok' ? '#69db7c' : '#ff6b6b', fontSize: '0.75rem' }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Dashboard — shown when user has no board selected or no boards
   ================================================================ */
function Dashboard({ username, authToken, userBoards, onBoardCreated, onSelectBoard }) {
  const [creating, setCreating] = useState(false);
  const [boardName, setBoardName] = useState('');
  const [error, setError] = useState(null);

  async function handleCreate() {
    const name = boardName.trim() || 'My Board';
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/boards`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.id) {
        onBoardCreated(data.id);
      } else {
        setError(data.error || 'Failed to create board');
        setCreating(false);
      }
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem('whiteboard-user');
    localStorage.removeItem('whiteboard-auth-token');
    window.location.reload();
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', background: '#1a1a2e',
      color: '#e0e0e0', fontFamily: 'system-ui, sans-serif', gap: '1.5rem',
    }}>
      <div style={{ fontSize: '2rem', fontWeight: 700 }}>Whiteboard</div>
      <div style={{ color: '#888' }}>Welcome, {username}</div>

      {userBoards.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '280px' }}>
          <div style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '0.25rem' }}>Your boards:</div>
          {userBoards.map(b => (
            <button key={b.id} onClick={() => onSelectBoard(b.id)} style={{
              padding: '0.75rem 1rem', background: '#2a2a4a', color: '#e0e0e0',
              border: '1px solid #3a3a5a', borderRadius: '8px', cursor: 'pointer',
              textAlign: 'left', fontSize: '1rem',
            }}>
              {b.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '280px', marginTop: '1rem' }}>
        <div style={{ color: '#aaa', fontSize: '0.85rem' }}>Create new board:</div>
        <input
          type="text"
          placeholder="Board name"
          value={boardName}
          onChange={e => setBoardName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
          style={{
            padding: '0.75rem', background: '#2a2a4a', color: '#e0e0e0',
            border: '1px solid #3a3a5a', borderRadius: '8px', fontSize: '1rem',
            outline: 'none',
          }}
        />
        <button
          onClick={handleCreate}
          disabled={creating}
          style={{
            padding: '0.75rem', background: '#6c8cff', color: 'white',
            border: 'none', borderRadius: '8px', cursor: 'pointer',
            fontSize: '1rem', fontWeight: 600, opacity: creating ? 0.6 : 1,
          }}
        >
          {creating ? 'Creating...' : 'Create Board'}
        </button>
        {error && <div style={{ color: '#ff6b6b', fontSize: '0.85rem' }}>{error}</div>}
      </div>

      <button onClick={handleLogout} style={{
        marginTop: '2rem', padding: '0.5rem 1rem', background: 'transparent',
        color: '#666', border: '1px solid #333', borderRadius: '6px',
        cursor: 'pointer', fontSize: '0.85rem',
      }}>
        Log out
      </button>
    </div>
  );
}

/* ================================================================
   APP COMPONENT
   ================================================================ */
export default function App() {
  const { authorized, loading, error, user, authToken } = useTelegramAuth();
  const isMobile = useMobile();

  const username = user?.username || '';
  const [userBoards, setUserBoards] = useState([]);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [boardId, setBoardId] = useState(null);
  const [showBoardPicker, setShowBoardPicker] = useState(false);
  const currentBoard = userBoards.find(b => b.id === boardId) || userBoards[0];

  // Load boards from server once auth is ready
  useEffect(() => {
    if (!authorized || !authToken) return;
    fetch(`${SERVER_URL}/api/boards`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    })
      .then(r => r.json())
      .then(boards => {
        if (Array.isArray(boards)) {
          setUserBoards(boards);
          const hashId = getBoardId();
          if (hashId && boards.some(b => b.id === hashId)) {
            setBoardId(hashId);
          } else if (boards.length === 1) {
            setBoardId(boards[0].id);
          }
          // else: null → dashboard
        }
        setBoardsLoaded(true);
      })
      .catch(() => setBoardsLoaded(true));
  }, [authorized, authToken]);

  // Sync hash only when we have a valid board
  useEffect(() => {
    if (boardId) window.location.hash = boardId;
  }, [boardId]);

  const switchBoard = useCallback((newId) => {
    window.location.hash = newId;
    setShowBoardPicker(false);
    // Full page reload is the cleanest way to switch boards —
    // avoids stale state, history bleed, and sync race conditions
    window.location.reload();
  }, []);

  const [state, setState] = useState(() => (boardId && loadState(boardId)) || defaultState());
  const [selectedId, setSelectedId] = useState(null);
  const [selectedType, setSelectedType] = useState(null); // 'node' | 'arrow' | null

  // Unified tool mode: 'select' | 'move' | 'draw' | 'eraser'
  const [toolMode, setToolMode] = useState('select');
  const [drawColor, setDrawColor] = useState('#6c8cff');
  const [drawWidth, setDrawWidth] = useState(2);

  // Draw options panel (double-tap draw button)
  const [showDrawOptions, setShowDrawOptions] = useState(false);
  const lastDrawTapRef = useRef(0);

  // Eraser state
  const [eraserMode, setEraserMode] = useState('object'); // 'object' | 'pixel'
  const [eraserRadius, setEraserRadius] = useState(16);

  // Rectangle selection state
  const [selection, setSelection] = useState({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });

  // Undo/Redo history
  const [history, setHistory] = useState(() => [takeSnapshot((boardId && loadState(boardId)) || defaultState())]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyLock = useRef(false); // prevent pushing history during undo/redo

  const { nodes, arrows, viewport, strokes = [] } = state;

  // --- Real-time sync ---
  // boardId is managed as state above (for board switching)
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const applyDelta = useCallback((delta) => {
    setState(prev => {
      switch (delta.type) {
        case 'node:add':
          return { ...prev, nodes: { ...prev.nodes, [delta.node.id]: delta.node } };
        case 'node:update': {
          const existing = prev.nodes[delta.id];
          if (!existing) return prev;
          return { ...prev, nodes: { ...prev.nodes, [delta.id]: { ...existing, ...delta.updates } } };
        }
        case 'node:delete': {
          const newNodes = { ...prev.nodes };
          delete newNodes[delta.id];
          const newArrows = {};
          for (const [aId, a] of Object.entries(prev.arrows)) {
            if (a.fromNodeId !== delta.id && a.toNodeId !== delta.id) newArrows[aId] = a;
          }
          return { ...prev, nodes: newNodes, arrows: newArrows };
        }
        case 'arrow:add':
          return { ...prev, arrows: { ...prev.arrows, [delta.arrow.id]: delta.arrow } };
        case 'arrow:update': {
          const ea = prev.arrows[delta.id];
          if (!ea) return prev;
          return { ...prev, arrows: { ...prev.arrows, [delta.id]: { ...ea, ...delta.updates } } };
        }
        case 'arrow:delete': {
          const newArrows = { ...prev.arrows };
          delete newArrows[delta.id];
          return { ...prev, arrows: newArrows };
        }
        case 'stroke:add':
          return { ...prev, strokes: [...(prev.strokes || []), delta.stroke] };
        case 'stroke:delete':
          return { ...prev, strokes: (prev.strokes || []).filter(s => s.id !== delta.id) };
        case 'stroke:pixel-erase':
          return { ...prev, strokes: delta.newStrokes };
        case 'state:undo':
          return { ...prev, nodes: delta.state.nodes, arrows: delta.state.arrows, strokes: delta.state.strokes };
        case 'erase:objects': {
          const nIds = new Set(delta.nodeIds || []);
          const aIds = new Set(delta.arrowIds || []);
          const sIds = new Set(delta.strokeIds || []);
          const nn = { ...prev.nodes }; for (const id of nIds) delete nn[id];
          const na = {}; for (const [aId, a] of Object.entries(prev.arrows)) {
            if (!aIds.has(aId) && !nIds.has(a.fromNodeId) && !nIds.has(a.toNodeId)) na[aId] = a;
          }
          const ns = (prev.strokes || []).filter(s => !sIds.has(s.id));
          return { ...prev, nodes: nn, arrows: na, strokes: ns };
        }
        default:
          return prev;
      }
    });
  }, []);

  const replaceState = useCallback((serverState) => {
    setState(prev => ({
      ...prev,
      nodes: serverState.nodes || {},
      arrows: serverState.arrows || {},
      strokes: serverState.strokes || [],
    }));
  }, []);

  const { send, users, connected, suppressRef } = useSync(SERVER_URL, boardId, {
    getState: () => stateRef.current,
    applyDelta,
    replaceState,
    username,
    authToken,
  });

  /* ================================================================
     Persistence - debounced save to localStorage
     ================================================================ */
  const saveTimer = useRef(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(storageKey(boardId), JSON.stringify({
          nodes: state.nodes,
          arrows: state.arrows,
          viewport: state.viewport,
          strokes: state.strokes || [],
        }));
      } catch {
        // Storage full or unavailable
      }
    }, SAVE_DEBOUNCE);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [state, boardId]);

  /* ================================================================
     History management
     ================================================================ */
  // Use refs for history to avoid stale closure issues
  const historyRef = useRef([takeSnapshot(loadState(getBoardId()) || defaultState())]);
  const historyIndexRef = useRef(0);

  const pushHistorySnapshot = useCallback((newState) => {
    if (historyLock.current) return;
    const snap = takeSnapshot(newState);
    // Trim forward history
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    trimmed.push(snap);
    // Enforce max
    if (trimmed.length > MAX_HISTORY) {
      trimmed.shift();
    } else {
      historyIndexRef.current += 1;
    }
    historyRef.current = trimmed;
    // Update React state for toolbar button disabled states
    setHistory(trimmed);
    setHistoryIndex(historyIndexRef.current);
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyLock.current = true;
    historyIndexRef.current -= 1;
    const snap = historyRef.current[historyIndexRef.current];
    setState(prev => applySnapshot(prev, snap));
    send({ type: 'state:undo', state: snap });
    setHistoryIndex(historyIndexRef.current);
    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    setSelectedId(null);
    setSelectedType(null);
    setTimeout(() => { historyLock.current = false; }, 0);
  }, [send]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyLock.current = true;
    historyIndexRef.current += 1;
    const snap = historyRef.current[historyIndexRef.current];
    setState(prev => applySnapshot(prev, snap));
    send({ type: 'state:undo', state: snap });
    setHistoryIndex(historyIndexRef.current);
    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    setSelectedId(null);
    setSelectedType(null);
    setTimeout(() => { historyLock.current = false; }, 0);
  }, [send]);

  /* Helper: setState + push history */
  const setStateWithHistory = useCallback((updater) => {
    setState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Push history in a microtask to avoid batching issues
      queueMicrotask(() => pushHistorySnapshot(next));
      return next;
    });
  }, [pushHistorySnapshot]);

  /* ================================================================
     State updaters
     ================================================================ */
  const onUpdateViewport = useCallback((vp) => {
    setState((prev) => ({ ...prev, viewport: vp }));
  }, []);

  const onAddNode = useCallback((x, y) => {
    const id = genId();
    const node = { id, x, y, text: '', color: '#6c8cff', width: 220 };
    setStateWithHistory((prev) => ({
      ...prev,
      nodes: { ...prev.nodes, [id]: node },
    }));
    send({ type: 'node:add', node });
    setSelectedId(id);
    setSelectedType('node');
  }, [setStateWithHistory, send]);

  const onUpdateNode = useCallback((id, updates) => {
    setState((prev) => {
      const existing = prev.nodes[id];
      if (!existing) return prev;
      return {
        ...prev,
        nodes: { ...prev.nodes, [id]: { ...existing, ...updates } },
      };
    });
    send({ type: 'node:update', id, updates });
  }, [send]);

  // Push history after node drag ends (called from Canvas on mouseup)
  const onNodeDragEnd = useCallback(() => {
    setState(prev => {
      pushHistorySnapshot(prev);
      return prev;
    });
  }, [pushHistorySnapshot]);

  const onDeleteNode = useCallback((id) => {
    setStateWithHistory((prev) => {
      const newNodes = { ...prev.nodes };
      delete newNodes[id];
      const newArrows = {};
      for (const [aId, arrow] of Object.entries(prev.arrows)) {
        if (arrow.fromNodeId !== id && arrow.toNodeId !== id) {
          newArrows[aId] = arrow;
        }
      }
      return { ...prev, nodes: newNodes, arrows: newArrows };
    });
    send({ type: 'node:delete', id });
    setSelectedId(null);
    setSelectedType(null);
  }, [setStateWithHistory, send]);

  const onAddArrow = useCallback((fromNodeId, fromAnchor, toNodeId, toAnchor) => {
    // Prevent duplicate arrows between same anchors
    const existing = Object.values(arrows).find(
      (a) => a.fromNodeId === fromNodeId && a.fromAnchor === fromAnchor &&
             a.toNodeId === toNodeId && a.toAnchor === toAnchor
    );
    if (existing) return;

    const id = 'a' + (nextId++) + '_' + Date.now().toString(36);
    const arrow = { id, fromNodeId, fromAnchor, toNodeId, toAnchor, color: '#6c8cff' };
    setStateWithHistory((prev) => ({
      ...prev,
      arrows: { ...prev.arrows, [id]: arrow },
    }));
    send({ type: 'arrow:add', arrow });
    setSelectedId(id);
    setSelectedType('arrow');
  }, [arrows, setStateWithHistory, send]);

  const onUpdateArrow = useCallback((id, updates) => {
    setStateWithHistory((prev) => {
      const existing = prev.arrows[id];
      if (!existing) return prev;
      return { ...prev, arrows: { ...prev.arrows, [id]: { ...existing, ...updates } } };
    });
    send({ type: 'arrow:update', id, updates });
  }, [setStateWithHistory, send]);

  const onDeleteArrow = useCallback((id) => {
    setStateWithHistory((prev) => {
      const newArrows = { ...prev.arrows };
      delete newArrows[id];
      return { ...prev, arrows: newArrows };
    });
    send({ type: 'arrow:delete', id });
    setSelectedId(null);
    setSelectedType(null);
  }, [setStateWithHistory, send]);

  const onAddStroke = useCallback((stroke) => {
    const strokeWithId = { ...stroke, id: stroke.id || genId('s') };
    setStateWithHistory((prev) => ({
      ...prev,
      strokes: [...(prev.strokes || []), strokeWithId],
    }));
    send({ type: 'stroke:add', stroke: strokeWithId });
  }, [setStateWithHistory, send]);

  const onSelect = useCallback((id, type) => {
    setSelectedId(id);
    setSelectedType(type);
  }, []);

  /* ================================================================
     Eraser callbacks
     ================================================================ */
  const onEraseObjects = useCallback((objectIds) => {
    if (!objectIds.nodeIds.length && !objectIds.arrowIds.length && !objectIds.strokeIds.length) return;
    send({ type: 'erase:objects', nodeIds: objectIds.nodeIds, arrowIds: objectIds.arrowIds, strokeIds: objectIds.strokeIds });
    setStateWithHistory((prev) => {
      const nodeIdSet = new Set(objectIds.nodeIds);
      const arrowIdSet = new Set(objectIds.arrowIds);
      const strokeIdSet = new Set(objectIds.strokeIds);

      // Remove nodes
      const newNodes = { ...prev.nodes };
      for (const id of nodeIdSet) delete newNodes[id];

      // Remove arrows (connected to deleted nodes, or explicitly erased)
      const newArrows = {};
      for (const [aId, arrow] of Object.entries(prev.arrows)) {
        if (arrowIdSet.has(aId)) continue;
        if (nodeIdSet.has(arrow.fromNodeId) || nodeIdSet.has(arrow.toNodeId)) continue;
        newArrows[aId] = arrow;
      }

      // Remove strokes
      const newStrokes = (prev.strokes || []).filter(s => !strokeIdSet.has(s.id));

      return { ...prev, nodes: newNodes, arrows: newArrows, strokes: newStrokes };
    });
  }, [setStateWithHistory, send]);

  const onPixelErase = useCallback((newStrokes) => {
    setStateWithHistory((prev) => ({
      ...prev,
      strokes: newStrokes,
    }));
    send({ type: 'stroke:pixel-erase', newStrokes });
  }, [setStateWithHistory, send]);

  /* ================================================================
     Rectangle selection callbacks
     ================================================================ */
  const onSelectionChange = useCallback((sel) => {
    setSelection(sel);
  }, []);

  const onDeleteSelection = useCallback(() => {
    const { nodeIds, arrowIds, strokeIds } = selection;
    if (nodeIds.size === 0 && arrowIds.size === 0 && strokeIds.size === 0) return;
    setStateWithHistory((prev) => {
      const newNodes = { ...prev.nodes };
      for (const id of nodeIds) delete newNodes[id];

      const newArrows = {};
      for (const [aId, arrow] of Object.entries(prev.arrows)) {
        if (arrowIds.has(aId)) continue;
        if (nodeIds.has(arrow.fromNodeId) || nodeIds.has(arrow.toNodeId)) continue;
        newArrows[aId] = arrow;
      }

      const newStrokes = (prev.strokes || []).filter(s => !strokeIds.has(s.id));
      return { ...prev, nodes: newNodes, arrows: newArrows, strokes: newStrokes };
    });
    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    setSelectedId(null);
    setSelectedType(null);
  }, [selection, setStateWithHistory]);

  // Move selected nodes (group drag)
  const onMoveSelection = useCallback((dx, dy) => {
    setState(prev => {
      const newNodes = { ...prev.nodes };
      for (const id of selection.nodeIds) {
        if (newNodes[id]) {
          newNodes[id] = { ...newNodes[id], x: newNodes[id].x + dx, y: newNodes[id].y + dy };
        }
      }
      // Move selected strokes
      const newStrokes = (prev.strokes || []).map(s => {
        if (selection.strokeIds.has(s.id)) {
          return {
            ...s,
            points: s.points.map(p => ({ x: p.x + dx, y: p.y + dy })),
          };
        }
        return s;
      });
      return { ...prev, nodes: newNodes, strokes: newStrokes };
    });
  }, [selection]);

  const onSelectionDragEnd = useCallback(() => {
    setState(prev => {
      pushHistorySnapshot(prev);
      return prev;
    });
  }, [pushHistorySnapshot]);

  /* ================================================================
     Keyboard shortcuts
     ================================================================ */
  useEffect(() => {
    function onKeyDown(e) {
      // Don't capture keys while typing in a node
      const active = document.activeElement;
      if (active && active.contentEditable === 'true') return;

      // Undo: Ctrl+Z / Cmd+Z (without shift)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'Z' && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      // Also handle Ctrl+Y for redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selection first
        if (selection.nodeIds.size > 0 || selection.arrowIds.size > 0 || selection.strokeIds.size > 0) {
          e.preventDefault();
          onDeleteSelection();
          return;
        }
        if (selectedId && selectedType === 'node') {
          e.preventDefault();
          onDeleteNode(selectedId);
        } else if (selectedId && selectedType === 'arrow') {
          e.preventDefault();
          onDeleteArrow(selectedId);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setSelectedType(null);
        setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
        if (toolMode !== 'select') setToolMode('select');
      setShowDrawOptions(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, selectedType, onDeleteNode, onDeleteArrow, selection, onDeleteSelection, undo, redo, toolMode]);

  /* ================================================================
     Draw button double-tap handler
     ================================================================ */
  const handleDrawTap = useCallback(() => {
    const now = Date.now();
    if (toolMode === 'draw' && now - lastDrawTapRef.current < 300) {
      setShowDrawOptions(prev => !prev);
    } else {
      setToolMode('draw');
      if (toolMode !== 'draw') setShowDrawOptions(false);
    }
    lastDrawTapRef.current = now;
  }, [toolMode]);

  /* ================================================================
     Toolbar actions
     ================================================================ */
  const handleAddNode = useCallback(() => {
    // Place new node at center of current view
    const cx = (window.innerWidth / 2 - viewport.panX) / viewport.zoom;
    const cy = (window.innerHeight / 2 - viewport.panY) / viewport.zoom;
    const GRID = 20;
    onAddNode(Math.round((cx - 110) / GRID) * GRID, Math.round((cy - 30) / GRID) * GRID);
  }, [viewport, onAddNode]);

  const handleZoomIn = useCallback(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let newZoom = viewport.zoom * 1.2;
    newZoom = Math.min(2.0, Math.max(0.15, newZoom));
    const scale = newZoom / viewport.zoom;
    onUpdateViewport({
      zoom: newZoom,
      panX: cx - (cx - viewport.panX) * scale,
      panY: cy - (cy - viewport.panY) * scale,
    });
  }, [viewport, onUpdateViewport]);

  const handleZoomOut = useCallback(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let newZoom = viewport.zoom / 1.2;
    newZoom = Math.min(2.0, Math.max(0.15, newZoom));
    const scale = newZoom / viewport.zoom;
    onUpdateViewport({
      zoom: newZoom,
      panX: cx - (cx - viewport.panX) * scale,
      panY: cy - (cy - viewport.panY) * scale,
    });
  }, [viewport, onUpdateViewport]);

  const handleFitView = useCallback(() => {
    const nodeArr = Object.values(nodes);
    if (nodeArr.length === 0) {
      onUpdateViewport({ panX: 0, panY: 0, zoom: 1 });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodeArr) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.width || 220));
      maxY = Math.max(maxY, n.y + 80);
    }
    const padding = 80;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const scaleX = window.innerWidth / contentW;
    const scaleY = window.innerHeight / contentH;
    let zoom = Math.min(scaleX, scaleY, 1.5);
    zoom = Math.min(2.0, Math.max(0.15, zoom));
    const panX = (window.innerWidth - contentW * zoom) / 2 - (minX - padding) * zoom;
    const panY = (window.innerHeight - contentH * zoom) / 2 - (minY - padding) * zoom;
    onUpdateViewport({ panX, panY, zoom });
  }, [nodes, onUpdateViewport]);

  /* ================================================================
     Color picker
     ================================================================ */
  const handleColorChange = useCallback((color) => {
    if (toolMode === 'draw') {
      setDrawColor(color);
    } else if (selectedId && selectedType === 'node') {
      onUpdateNode(selectedId, { color });
      pushHistorySnapshot({ ...state, nodes: { ...state.nodes, [selectedId]: { ...state.nodes[selectedId], color } } });
    } else if (selectedId && selectedType === 'arrow') {
      const newState = {
        ...state,
        arrows: { ...state.arrows, [selectedId]: { ...state.arrows[selectedId], color } },
      };
      setState(newState);
      pushHistorySnapshot(newState);
    }
  }, [selectedId, selectedType, onUpdateNode, toolMode, state, pushHistorySnapshot]);

  const activeColor = toolMode === 'draw' ? drawColor
    : selectedId && selectedType === 'node' ? (nodes[selectedId]?.color || '#6c8cff')
    : selectedId && selectedType === 'arrow' ? (arrows[selectedId]?.color || '#6c8cff')
    : null;

  const showPalette = toolMode === 'draw' || selectedId;

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  /* ================================================================
     Render
     ================================================================ */
  if (loading || (authorized && !boardsLoaded)) {
    return <div className="auth-gate"><p>Loading...</p></div>;
  }
  if (!authorized) {
    // Show login page when opened outside Telegram (web browser)
    if (error === 'not_authenticated') {
      return <LoginPage />;
    }
    return (
      <div className="auth-gate">
        <p>{error || 'Open this whiteboard from Telegram'}</p>
      </div>
    );
  }

  // Dashboard: no boards yet — show create board UI
  if (!boardId) {
    return (
      <Dashboard
        username={username}
        authToken={authToken}
        userBoards={userBoards}
        onBoardCreated={(newId) => {
          window.location.hash = newId;
          window.location.reload();
        }}
        onSelectBoard={(id) => {
          window.location.hash = id;
          window.location.reload();
        }}
      />
    );
  }

  return (
    <>
      {/* Board picker */}
      <div className="board-picker-container">
        <button className="board-picker-btn" onClick={() => setShowBoardPicker(p => !p)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {currentBoard?.name || 'Board'}
        </button>
        {showBoardPicker && (
          <div className="board-picker-dropdown">
            {userBoards.map(b => (
              <button
                key={b.id}
                className={`board-picker-item${b.id === boardId ? ' active' : ''}`}
                onClick={() => switchBoard(b.id)}
              >
                {b.name}
                {b.id === boardId && <span className="board-picker-check">✓</span>}
              </button>
            ))}
            <button
              className="board-picker-item"
              onClick={() => { window.location.hash = ''; window.location.reload(); }}
              style={{ borderTop: '1px solid #3a3a5a', color: '#6c8cff' }}
            >
              + New board / Dashboard
            </button>
          </div>
        )}
      </div>

      {/* Members panel (owner only) */}
      {currentBoard?.role === 'owner' && (
        <MembersPanel boardId={boardId} authToken={authToken} />
      )}

      {/* Toolbar */}
      <div className="toolbar">
        <button className="toolbar-btn" onClick={handleAddNode} title="Add Node">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Add Node
        </button>
        <div className="toolbar-divider" />

        {/* Tool mode buttons */}
        <button
          className={`toolbar-btn${toolMode === 'select' ? ' tool-active' : ''}`}
          onClick={() => { setToolMode('select'); setShowDrawOptions(false); }}
          title="Select (pointer)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 2l2 12 3-4 5-1L3 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
          </svg>
          Select
        </button>
        <button
          className={`toolbar-btn${toolMode === 'move' ? ' tool-active' : ''}`}
          onClick={() => { setToolMode('move'); setShowDrawOptions(false); }}
          title="Move (pan)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 1v14M1 8h14M8 1l-2.5 2.5M8 1l2.5 2.5M8 15l-2.5-2.5M8 15l2.5-2.5M1 8l2.5-2.5M1 8l2.5 2.5M15 8l-2.5-2.5M15 8l-2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Move
        </button>
        <button
          className={`toolbar-btn${toolMode === 'draw' ? ' tool-active' : ''}`}
          onClick={handleDrawTap}
          title="Draw (freehand, double-tap for options)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 13.5s1-2 3-4 4-3.5 5.5-5S13 2.5 13 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Draw
        </button>
        <button
          className={`toolbar-btn${toolMode === 'eraser' ? ' tool-active' : ''}`}
          onClick={() => { setToolMode('eraser'); setShowDrawOptions(false); }}
          title="Eraser"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 14h8M3.5 11.5l7-7a1.41 1.41 0 012 2l-7 7H3l-.5-.5a1.41 1.41 0 010-2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Eraser
        </button>

        {/* Eraser options */}
        {toolMode === 'eraser' && (
          <>
            <div className="eraser-options">
              <button
                className={`eraser-mode-btn${eraserMode === 'object' ? ' active' : ''}`}
                onClick={() => setEraserMode('object')}
                title="Object eraser: removes entire objects"
              >
                Object
              </button>
              <button
                className={`eraser-mode-btn${eraserMode === 'pixel' ? ' active' : ''}`}
                onClick={() => setEraserMode('pixel')}
                title="Pixel eraser: splits strokes"
              >
                Pixel
              </button>
            </div>
            <input
              type="range"
              className="eraser-radius-slider"
              min="8"
              max="40"
              value={eraserRadius}
              onChange={(e) => setEraserRadius(Number(e.target.value))}
              title={`Radius: ${eraserRadius}px`}
            />
          </>
        )}

        <div className="toolbar-divider" />

        {/* Undo / Redo */}
        <button
          className="toolbar-btn"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 6h7a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 3L3 6l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="toolbar-btn"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M13 6H6a3 3 0 000 6h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="toolbar-divider" />

        {/* Zoom controls */}
        <button className="toolbar-btn" onClick={handleZoomIn} title="Zoom In">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M7 5v4M5 7h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button className="toolbar-btn" onClick={handleZoomOut} title="Zoom Out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M5 7h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button className="toolbar-btn" onClick={handleFitView} title="Fit View">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Color palette - shown when something is selected or in draw mode */}
        {showPalette && (
          <>
            <div className="toolbar-divider" />
            <div className="color-palette">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`color-swatch${activeColor === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => handleColorChange(c)}
                  title={c}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Draw options panel (color + width picker) */}
      {showDrawOptions && toolMode === 'draw' && (
        <div className="draw-options">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`color-swatch small${drawColor === c ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => setDrawColor(c)}
              title={c}
            />
          ))}
          <div className="toolbar-divider" />
          {[1, 2, 4, 8].map((w) => (
            <button
              key={w}
              className={`width-btn${drawWidth === w ? ' active' : ''}`}
              onClick={() => setDrawWidth(w)}
              title={`${w}px`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16">
                <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
              </svg>
            </button>
          ))}
        </div>
      )}

      {/* Canvas */}
      <Canvas
        nodes={nodes}
        arrows={arrows}
        viewport={viewport}
        selectedId={selectedId}
        selectedType={selectedType}
        onUpdateViewport={onUpdateViewport}
        onAddNode={onAddNode}
        onUpdateNode={onUpdateNode}
        onAddArrow={onAddArrow}
        onSelect={onSelect}
        toolMode={toolMode}
        drawColor={drawColor}
        drawWidth={drawWidth}
        drawStrokes={strokes}
        onAddStroke={onAddStroke}
        eraserMode={eraserMode}
        eraserRadius={eraserRadius}
        onEraseObjects={onEraseObjects}
        onPixelErase={onPixelErase}
        selection={selection}
        onSelectionChange={onSelectionChange}
        onMoveSelection={onMoveSelection}
        onSelectionDragEnd={onSelectionDragEnd}
        onNodeDragEnd={onNodeDragEnd}
        isMobile={isMobile}
        onUpdateArrow={onUpdateArrow}
      />
    </>
  );
}
