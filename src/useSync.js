/**
 * useSync — WebSocket hook for real-time board collaboration.
 *
 * Connects to the server, sends local changes as deltas,
 * and applies incoming deltas from other users.
 */
import { useEffect, useRef, useCallback, useState } from 'react';

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 10000;

export default function useSync(serverUrl, boardId, {
  getState,      // () => { nodes, arrows, strokes }
  applyDelta,    // (delta) => void — apply a remote delta to local state
  replaceState,  // (state) => void — full state replace (init / undo from remote)
  username,      // Telegram username for board access control
}) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(RECONNECT_BASE);
  const [users, setUsers] = useState([]); // [{ userId, color }]
  const [connected, setConnected] = useState(false);
  const suppressRef = useRef(false); // suppress broadcasting when applying remote deltas

  const connect = useCallback(() => {
    if (!serverUrl || !boardId) return;

    const protocol = serverUrl.startsWith('https') ? 'wss' : 'ws';
    const host = serverUrl.replace(/^https?:\/\//, '');
    const url = `${protocol}://${host}/ws/${boardId}${username ? '?user=' + encodeURIComponent(username) : ''}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[sync] connected to', boardId);
      setConnected(true);
      reconnectDelay.current = RECONNECT_BASE;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'init':
            suppressRef.current = true;
            replaceState(msg.state);
            suppressRef.current = false;
            break;
          case 'users':
            setUsers(msg.users || []);
            break;
          case 'user:join':
            setUsers(prev => [...prev, { userId: msg.userId, color: msg.color }]);
            break;
          case 'user:leave':
            setUsers(prev => prev.filter(u => u.userId !== msg.userId));
            break;
          case 'cursor':
            // Could render remote cursors — skip for now
            break;
          default:
            // All other delta types — apply remotely
            suppressRef.current = true;
            applyDelta(msg);
            suppressRef.current = false;
            break;
        }
      } catch (e) {
        console.warn('[sync] bad message:', e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Reconnect with backoff
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 1.5, RECONNECT_MAX);
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [serverUrl, boardId, replaceState, applyDelta]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  /** Send a delta to the server (will be broadcast to other clients) */
  const send = useCallback((delta) => {
    if (suppressRef.current) return; // don't echo remote deltas back
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(delta));
    }
  }, []);

  return { send, users, connected, suppressRef };
}
