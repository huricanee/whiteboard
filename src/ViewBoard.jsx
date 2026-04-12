/**
 * ViewBoard — read-only board viewer for public share links.
 * Fetches board data via view token, renders canvas without editing tools.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import Canvas from './Canvas.jsx';
import 'katex/dist/katex.min.css';

const SERVER_URL = 'https://whiteboard-production-ec19.up.railway.app';

export default function ViewBoard({ token }) {
  const [status, setStatus] = useState('loading');
  const [board, setBoard] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [viewport, setViewport] = useState({ panX: 0, panY: 0, zoom: 1 });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    fetch(`${SERVER_URL}/api/view/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setBoard(data.board);
          setState({
            ...data.state,
            viewport: { panX: 0, panY: 0, zoom: 1 },
          });
          setStatus('ok');
        } else {
          setStatus('error');
          setError(data.error || 'Invalid link');
        }
      })
      .catch(err => {
        setStatus('error');
        setError(err.message);
      });
  }, [token]);

  const onUpdateViewport = useCallback((vp) => setViewport(vp), []);
  const noop = useCallback(() => {}, []);
  const noopSelection = { nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() };

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1a1a2e', color: '#888' }}>
        Loading...
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1a1a2e', color: '#e0e0e0', gap: '1rem' }}>
        <div style={{ fontSize: '1.5rem', color: '#ff6b6b' }}>Link invalid or expired</div>
        <div style={{ color: '#888' }}>{error}</div>
      </div>
    );
  }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Board name banner */}
      <div style={{
        position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)',
        zIndex: 1000, padding: '6px 16px', background: '#1e1e36ee',
        border: '1px solid #3a3a5a', borderRadius: '8px', color: '#aaa',
        fontSize: '0.85rem', pointerEvents: 'none',
      }}>
        {board.name} <span style={{ color: '#666', fontSize: '0.75rem' }}>view only</span>
      </div>

      <Canvas
        nodes={state.nodes || {}}
        arrows={state.arrows || {}}
        viewport={viewport}
        selectedId={null}
        selectedType={null}
        onUpdateViewport={onUpdateViewport}
        onAddNode={noop}
        onUpdateNode={noop}
        onAddArrow={noop}
        onSelect={noop}
        toolMode="move"
        drawColor="#6c8cff"
        drawWidth={2}
        drawStrokes={state.strokes || []}
        onAddStroke={noop}
        eraserMode="object"
        eraserRadius={16}
        onEraseObjects={noop}
        onPixelErase={noop}
        selection={noopSelection}
        onSelectionChange={noop}
        onMoveSelection={noop}
        onSelectionDragEnd={noop}
        onNodeDragEnd={noop}
        isMobile={window.innerWidth <= 768}
        onUpdateArrow={noop}
        sourceMode={false}
        regions={state.regions || {}}
        onUpdateRegion={noop}
        onRegionDragEnd={noop}
      />
    </div>
  );
}
