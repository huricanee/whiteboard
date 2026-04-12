import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import './canvas.css';
import 'katex/dist/katex.min.css';
import { hasLatex, renderLatexToHtml } from './latex.js';

const GRID_SIZE = 20;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.0;
const ZOOM_IN_FACTOR = 1.08;
const ZOOM_OUT_FACTOR = 0.92;

const ANCHORS = ['top', 'right', 'bottom', 'left'];

/* ================================================================
   Utility: get anchor world position for a node
   ================================================================ */
function getAnchorPos(node, anchor, heightMap) {
  const w = node.width || 220;
  const h = (heightMap && heightMap[node.id]) || 60;
  switch (anchor) {
    case 'top':    return { x: node.x + w / 2, y: node.y };
    case 'right':  return { x: node.x + w,     y: node.y + h / 2 };
    case 'bottom': return { x: node.x + w / 2, y: node.y + h };
    case 'left':   return { x: node.x,         y: node.y + h / 2 };
    default:       return { x: node.x + w / 2, y: node.y + h / 2 };
  }
}

/* ================================================================
   Utility: cubic bezier path between two anchor endpoints
   ================================================================ */
function bezierPath(sx, sy, fromAnchor, ex, ey, toAnchor) {
  const dist = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
  const tension = Math.max(dist * 0.4, 40);

  let cp1x = sx, cp1y = sy;
  switch (fromAnchor) {
    case 'right':  cp1x = sx + tension; break;
    case 'left':   cp1x = sx - tension; break;
    case 'top':    cp1y = sy - tension; break;
    case 'bottom': cp1y = sy + tension; break;
  }

  let cp2x = ex, cp2y = ey;
  switch (toAnchor) {
    case 'right':  cp2x = ex + tension; break;
    case 'left':   cp2x = ex - tension; break;
    case 'top':    cp2y = ey - tension; break;
    case 'bottom': cp2y = ey + tension; break;
  }

  // Midpoint of cubic bezier at t=0.5
  const midX = 0.125 * sx + 0.375 * cp1x + 0.375 * cp2x + 0.125 * ex;
  const midY = 0.125 * sy + 0.375 * cp1y + 0.375 * cp2y + 0.125 * ey;

  return { path: `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${ex} ${ey}`, cp2x, cp2y, midX, midY };
}

/* ================================================================
   Utility: arrowhead points at end of curve
   ================================================================ */
function arrowheadPoints(ex, ey, cp2x, cp2y, size = 10) {
  const dx = ex - cp2x;
  const dy = ey - cp2y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const x1 = ex - ux * size + px * size * 0.4;
  const y1 = ey - uy * size + py * size * 0.4;
  const x2 = ex - ux * size - px * size * 0.4;
  const y2 = ey - uy * size - py * size * 0.4;
  return `${ex},${ey} ${x1},${y1} ${x2},${y2}`;
}

/* ================================================================
   Utility: closest anchor on a node to a world point
   ================================================================ */
function closestAnchor(node, wx, wy, heightMap) {
  let best = null;
  let bestDist = Infinity;
  for (const a of ANCHORS) {
    const p = getAnchorPos(node, a, heightMap);
    const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return { anchor: best, dist: Math.sqrt(bestDist) };
}

/* ================================================================
   Utility: snap to grid
   ================================================================ */
function snap(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

/* ================================================================
   Utility: convert freehand points to smoothed SVG path
   ================================================================ */
function pointsToPath(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const mx = (prev.x + cur.x) / 2;
    const my = (prev.y + cur.y) / 2;
    d += ` Q ${prev.x} ${prev.y}, ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/* ================================================================
   Utility: distance from point to line segment
   ================================================================ */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/* ================================================================
   Utility: check if point is within radius of any stroke point/segment
   ================================================================ */
function strokeHitsCircle(stroke, cx, cy, radius) {
  if (!stroke.points || stroke.points.length === 0) return false;
  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    const dist = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
    if (dist <= radius) return true;
    if (i > 0) {
      const prev = stroke.points[i - 1];
      if (distToSegment(cx, cy, prev.x, prev.y, p.x, p.y) <= radius) return true;
    }
  }
  return false;
}

/* ================================================================
   Utility: check if eraser circle overlaps a node rect
   ================================================================ */
function nodeHitsCircle(node, cx, cy, radius, heightMap) {
  const w = node.width || 220;
  const h = (heightMap && heightMap[node.id]) || 60;
  // Closest point on rect to circle center
  const closestX = Math.max(node.x, Math.min(cx, node.x + w));
  const closestY = Math.max(node.y, Math.min(cy, node.y + h));
  const dist = Math.sqrt((cx - closestX) ** 2 + (cy - closestY) ** 2);
  return dist <= radius;
}

/* ================================================================
   Utility: check if arrow (bezier) hits eraser circle
   ================================================================ */
function arrowHitsCircle(arrow, nodes, cx, cy, radius, heightMap) {
  const fromNode = nodes[arrow.fromNodeId];
  const toNode = nodes[arrow.toNodeId];
  if (!fromNode || !toNode) return false;
  const from = getAnchorPos(fromNode, arrow.fromAnchor, heightMap);
  const to = getAnchorPos(toNode, arrow.toAnchor, heightMap);
  // Sample the bezier at intervals and check distance
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Simple linear approximation for hit testing
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) <= radius) return true;
  }
  return false;
}

/* ================================================================
   Utility: pixel erase - split strokes around erased points
   ================================================================ */
function pixelEraseStrokes(strokes, cx, cy, radius) {
  let changed = false;
  const result = [];
  let idCounter = Date.now();

  for (const stroke of strokes) {
    if (!stroke.points || stroke.points.length === 0) {
      result.push(stroke);
      continue;
    }

    // Check if any point is within eraser radius
    let hasHit = false;
    for (const p of stroke.points) {
      if (Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2) <= radius) {
        hasHit = true;
        break;
      }
    }

    if (!hasHit) {
      result.push(stroke);
      continue;
    }

    changed = true;
    // Split points into contiguous groups outside the eraser
    const groups = [];
    let currentGroup = [];
    for (const p of stroke.points) {
      const dist = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
      if (dist > radius) {
        currentGroup.push(p);
      } else {
        if (currentGroup.length > 1) {
          groups.push(currentGroup);
        }
        currentGroup = [];
      }
    }
    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }

    // Create new strokes from groups
    for (const group of groups) {
      result.push({
        id: 's_pe_' + (idCounter++),
        points: group,
        color: stroke.color,
        width: stroke.width,
      });
    }
  }

  return { strokes: result, changed };
}

/* ================================================================
   Utility: check if rect overlaps another rect
   ================================================================ */
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ================================================================
   Utility: compute bounding box of a selection (nodes + strokes)
   ================================================================ */
function getSelectionBounds(sel, nodes, strokes, heightMap) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of sel.nodeIds) {
    const n = nodes[id];
    if (!n) continue;
    const w = n.width || 220;
    const h = (heightMap && heightMap[id]) || 60;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  for (const id of sel.strokeIds) {
    const s = (strokes || []).find(st => st.id === id);
    if (!s || !s.points) continue;
    for (const p of s.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ================================================================
   CANVAS COMPONENT
   ================================================================ */
export default function Canvas({
  nodes,
  arrows,
  viewport,
  selectedId,
  selectedType,
  onUpdateViewport,
  onAddNode,
  onUpdateNode,
  onAddArrow,
  onSelect,
  toolMode,
  drawColor,
  drawWidth,
  drawStrokes,
  onAddStroke,
  eraserMode,
  eraserRadius,
  onEraseObjects,
  onPixelErase,
  selection,
  onSelectionChange,
  onMoveSelection,
  onSelectionDragEnd,
  onNodeDragEnd,
  isMobile,
  onUpdateArrow,
  sourceMode,
  regions = {},
  onUpdateRegion,
  onRegionDragEnd,
}) {
  const rootRef = useRef(null);
  const transformRef = useRef(null);

  /* ---- internal refs for drag state (not React state to avoid re-renders) ---- */
  const dragState = useRef(null);      // { type: 'pan' | 'node' | 'arrow' | 'draw' | 'erase' | 'rectSelect' | 'selectionDrag', ... }
  const panRAF = useRef(null);
  const vpRef = useRef(viewport);      // always-current viewport for event handlers

  // Sync vpRef via effect instead of during render
  useEffect(() => {
    vpRef.current = viewport;
  }, [viewport]);

  /* ---- node height state for anchor position computation (state, not ref, so render can read it) ---- */
  const [nodeHeightMap, setNodeHeightMap] = useState({});
  // We also keep a mutable mirror for use inside event handlers (which run outside render)
  const nodeHeightRef = useRef({});

  /* ---- Arrow preview state (while dragging from anchor) ---- */
  const [arrowPreview, setArrowPreview] = useState(null);

  /* ---- Refs for mobile touch handler closures ---- */
  const drawColorRef = useRef(drawColor);
  useEffect(() => { drawColorRef.current = drawColor; }, [drawColor]);
  const drawWidthRef = useRef(drawWidth || 2);
  useEffect(() => { drawWidthRef.current = drawWidth || 2; }, [drawWidth]);
  const selectionRef = useRef(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  /* ---- Freehand drawing state ---- */
  const currentStroke = useRef(null); // { points: [{x,y},...], color, width }
  const [drawingPreview, setDrawingPreview] = useState(null); // SVG path string while drawing

  /* ---- Dragging node id as state for CSS class ---- */
  const [draggingNodeId, setDraggingNodeId] = useState(null);

  /* ---- Eraser cursor position (world coords) ---- */
  const [eraserCursor, setEraserCursor] = useState(null);

  /* ---- Rectangle selection visual ---- */
  const [selectRect, setSelectRect] = useState(null); // { x, y, w, h } in world coords

  /* ================================================================
     Coordinate conversions
     ================================================================ */
  const screenToWorld = useCallback((sx, sy) => {
    const vp = vpRef.current;
    return {
      x: (sx - vp.panX) / vp.zoom,
      y: (sy - vp.panY) / vp.zoom,
    };
  }, []);

  /* ================================================================
     Zoom (mouse-centric)
     ================================================================ */
  const applyZoom = useCallback((factor, cx, cy) => {
    const vp = vpRef.current;
    let newZoom = vp.zoom * factor;
    newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const scale = newZoom / vp.zoom;
    onUpdateViewport({
      zoom: newZoom,
      panX: cx - (cx - vp.panX) * scale,
      panY: cy - (cy - vp.panY) * scale,
    });
  }, [onUpdateViewport]);

  /* ================================================================
     Wheel handler - Ctrl/Meta = zoom, otherwise pan
     ================================================================ */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    function onWheel(e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR;
        applyZoom(factor, mx, my);
      } else {
        const vp = vpRef.current;
        onUpdateViewport({
          ...vp,
          panX: vp.panX - e.deltaX,
          panY: vp.panY - e.deltaY,
        });
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, onUpdateViewport]);

  /* ================================================================
     Touch handling — DESKTOP (existing, unchanged)
     ================================================================ */
  useEffect(() => {
    if (isMobile) return; // mobile has its own handler below
    const el = rootRef.current;
    if (!el) return;

    let lastTouches = null;

    function onTouchStart(e) {
      if (e.touches.length === 1) {
        lastTouches = [{ x: e.touches[0].clientX, y: e.touches[0].clientY }];
      } else if (e.touches.length === 2) {
        e.preventDefault();
        lastTouches = [
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        ];
      }
    }

    function onTouchMove(e) {
      if (!lastTouches) return;
      if (e.touches.length === 1 && lastTouches.length === 1) {
        if (dragState.current) return;
        const dx = e.touches[0].clientX - lastTouches[0].x;
        const dy = e.touches[0].clientY - lastTouches[0].y;
        const vp = vpRef.current;
        onUpdateViewport({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy });
        lastTouches = [{ x: e.touches[0].clientX, y: e.touches[0].clientY }];
      } else if (e.touches.length === 2 && lastTouches.length === 2) {
        e.preventDefault();
        const prev = lastTouches;
        const cur = [
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        ];
        const prevDist = Math.sqrt((prev[1].x - prev[0].x) ** 2 + (prev[1].y - prev[0].y) ** 2);
        const curDist = Math.sqrt((cur[1].x - cur[0].x) ** 2 + (cur[1].y - cur[0].y) ** 2);
        const rect = el.getBoundingClientRect();
        const cx = (cur[0].x + cur[1].x) / 2 - rect.left;
        const cy = (cur[0].y + cur[1].y) / 2 - rect.top;
        const factor = curDist / (prevDist || 1);
        applyZoom(factor, cx, cy);

        const prevCx = (prev[0].x + prev[1].x) / 2 - rect.left;
        const prevCy = (prev[0].y + prev[1].y) / 2 - rect.top;
        const vp = vpRef.current;
        onUpdateViewport({ ...vp, panX: vp.panX + (cx - prevCx), panY: vp.panY + (cy - prevCy) });

        lastTouches = cur;
      }
    }

    function onTouchEnd() {
      lastTouches = null;
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [isMobile, applyZoom, onUpdateViewport]);

  /* ================================================================
     Touch handling — MOBILE
     1 finger behavior depends on toolMode:
       - 'move': pan + drag nodes + create arrows + tap to edit
       - 'draw': draw stroke
       - 'eraser': erase
       - 'select': rect selection
     2 fingers: ALWAYS pinch zoom + pan (any tool mode)
     ================================================================ */
  // Touch state as ref so it survives React re-renders during touch gestures
  // (e.g. erasing objects triggers re-render which could reset local variables)
  const touchStateRef = useRef(null);

  useEffect(() => {
    if (!isMobile) return;
    const el = rootRef.current;
    if (!el) return;

    const getDist = (t1, t2) => Math.sqrt((t1.clientX - t2.clientX) ** 2 + (t1.clientY - t2.clientY) ** 2);
    const getMid = (t1, t2) => ({ x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 });

    // Helper: find if touch is near an anchor dot on any node (within threshold px)
    // Skips text-style nodes (they have no anchors).
    function findNearAnchor(world, threshold) {
      const currentNodes = nodesRef.current;
      const hm = nodeHeightRef.current;
      for (const nid of Object.keys(currentNodes)) {
        const n = currentNodes[nid];
        if (n.style === 'text') continue;
        for (const a of ANCHORS) {
          const pos = getAnchorPos(n, a, hm);
          const dist = Math.sqrt((world.x - pos.x) ** 2 + (world.y - pos.y) ** 2);
          if (dist < threshold / vpRef.current.zoom) {
            return { nodeId: nid, anchor: a };
          }
        }
      }
      return null;
    }

    function switchToPinch(e) {
      // Save partial stroke if we were drawing
      if (touchStateRef.current && touchStateRef.current.type === 'draw' && currentStroke.current) {
        if (currentStroke.current.points.length > 1 && onAddStroke) {
          onAddStroke({ ...currentStroke.current });
        }
        currentStroke.current = null;
        setDrawingPreview(null);
      }
      // Cancel any rect selection
      if (touchStateRef.current && touchStateRef.current.type === 'rectSelect') {
        setSelectRect(null);
      }
      const dist = getDist(e.touches[0], e.touches[1]);
      const mid = getMid(e.touches[0], e.touches[1]);
      const vp = vpRef.current;
      touchStateRef.current = {
        type: 'pinch',
        initialDist: dist,
        initialZoom: vp.zoom,
        initialPanX: vp.panX,
        initialPanY: vp.panY,
        lastMid: mid,
      };
    }

    function onTouchStart(e) {
      // Don't capture touches on toolbar or draw options
      if (e.target.closest('.toolbar') || e.target.closest('.draw-options')) return;

      e.preventDefault();

      // 2 fingers: ALWAYS pinch zoom + pan, regardless of tool
      if (e.touches.length === 2) {
        switchToPinch(e);
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = el.getBoundingClientRect();
        const mx = t.clientX - rect.left;
        const my = t.clientY - rect.top;
        const world = screenToWorld(mx, my);
        const mode = toolModeRef.current;

        // Check if touching a node
        const currentNodes = nodesRef.current;
        const hm = nodeHeightRef.current;
        let hitNodeId = null;
        for (const nid of Object.keys(currentNodes)) {
          const n = currentNodes[nid];
          const w = n.width || 220;
          const h = hm[nid] || 60;
          if (world.x >= n.x && world.x <= n.x + w && world.y >= n.y && world.y <= n.y + h) {
            hitNodeId = nid;
            break;
          }
        }

        // === MOVE MODE (default on mobile) ===
        // Pan canvas, but also: drag nodes, create arrows from anchors, tap to select/edit
        if (mode === 'move') {
          // Check if touch is near an anchor -> start arrow creation
          const anchorHit = findNearAnchor(world, 20);
          if (anchorHit) {
            touchStateRef.current = {
              type: 'arrow-preview',
              fromNodeId: anchorHit.nodeId,
              fromAnchor: anchorHit.anchor,
              moved: false,
            };
            setArrowPreview({
              fromNodeId: anchorHit.nodeId,
              fromAnchor: anchorHit.anchor,
              cursorX: world.x,
              cursorY: world.y,
              snapNodeId: null,
              snapAnchor: null,
            });
            return;
          }

          if (hitNodeId) {
            // Check if part of multi-selection -> group drag
            const sel = selectionRef.current;
            if (sel.nodeIds.has(hitNodeId) && (sel.nodeIds.size > 1 || sel.strokeIds.size > 0)) {
              touchStateRef.current = {
                type: 'selectionDrag',
                startWorldX: world.x,
                startWorldY: world.y,
                lastWorldX: world.x,
                lastWorldY: world.y,
              };
              return;
            }
            // Drag single node (offset from node origin, not just left edge)
            const n = currentNodes[hitNodeId];
            onSelect(hitNodeId, 'node');
            touchStateRef.current = {
              type: 'node-drag',
              nodeId: hitNodeId,
              offsetX: world.x - n.x,
              offsetY: world.y - n.y,
              startX: t.clientX,
              startY: t.clientY,
              moved: false,
            };
            setDraggingNodeId(hitNodeId);
            return;
          }

          // Background: pan
          touchStateRef.current = {
            type: 'pan',
            lastX: t.clientX,
            lastY: t.clientY,
            startX: t.clientX,
            startY: t.clientY,
            moved: false,
          };
          return;
        }

        // === SELECT MODE (rect selection) ===
        if (mode === 'select') {
          // Check if inside selection bounding box -> drag selection
          const sel = selectionRef.current;
          if (sel.strokeIds.size > 0 || sel.nodeIds.size > 0) {
            const bounds = getSelectionBounds(sel, currentNodes, drawStrokesRef.current, hm);
            if (bounds && world.x >= bounds.x && world.x <= bounds.x + bounds.w &&
                world.y >= bounds.y && world.y <= bounds.y + bounds.h) {
              touchStateRef.current = {
                type: 'selectionDrag',
                startWorldX: world.x,
                startWorldY: world.y,
                lastWorldX: world.x,
                lastWorldY: world.y,
              };
              return;
            }
          }

          // Background drag -> rect selection
          onSelect(null, null);
          onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
          touchStateRef.current = {
            type: 'rectSelect',
            startWorld: world,
            startScreen: { x: mx, y: my },
            moved: false,
          };
          return;
        }

        // === DRAW MODE ===
        if (mode === 'draw') {
          currentStroke.current = { points: [{ x: world.x, y: world.y }], color: drawColorRef.current || '#6c8cff', width: drawWidthRef.current || 2 };
          touchStateRef.current = { type: 'draw' };
          setDrawingPreview(pointsToPath([{ x: world.x, y: world.y }]));
          return;
        }

        // === ERASER MODE ===
        if (mode === 'eraser') {
          touchStateRef.current = { type: 'erase' };
          setEraserCursor(world);
          if (performEraseRef.current) performEraseRef.current(world.x, world.y);
          return;
        }

        // Fallback: pan
        touchStateRef.current = {
          type: 'pan',
          lastX: t.clientX,
          lastY: t.clientY,
          startX: t.clientX,
          startY: t.clientY,
          moved: false,
        };
      }
    }

    function onTouchMove(e) {
      if (!touchStateRef.current) return;
      e.preventDefault();

      // 2 fingers: always pinch
      if (e.touches.length === 2) {
        if (touchStateRef.current.type !== 'pinch') {
          switchToPinch(e);
          return;
        }
        const dist = getDist(e.touches[0], e.touches[1]);
        const mid = getMid(e.touches[0], e.touches[1]);
        const scale = dist / touchStateRef.current.initialDist;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, touchStateRef.current.initialZoom * scale));
        const rect = el.getBoundingClientRect();
        const mx = mid.x - rect.left;
        const my = mid.y - rect.top;
        const zoomRatio = newZoom / touchStateRef.current.initialZoom;
        onUpdateViewport({
          panX: mx - (mx - touchStateRef.current.initialPanX) * zoomRatio,
          panY: my - (my - touchStateRef.current.initialPanY) * zoomRatio,
          zoom: newZoom,
        });
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = el.getBoundingClientRect();
        const mx = t.clientX - rect.left;
        const my = t.clientY - rect.top;
        const vp = vpRef.current;
        const wx = (mx - vp.panX) / vp.zoom;
        const wy = (my - vp.panY) / vp.zoom;

        if (touchStateRef.current.type === 'draw') {
          if (currentStroke.current) {
            currentStroke.current.points.push({ x: wx, y: wy });
            setDrawingPreview(pointsToPath(currentStroke.current.points));
          }
        } else if (touchStateRef.current.type === 'erase') {
          setEraserCursor({ x: wx, y: wy });
          if (performEraseRef.current) performEraseRef.current(wx, wy);
        } else if (touchStateRef.current.type === 'node-drag') {
          touchStateRef.current.moved = true;
          onUpdateNode(touchStateRef.current.nodeId, { x: snap(wx - touchStateRef.current.offsetX), y: snap(wy - touchStateRef.current.offsetY) });
        } else if (touchStateRef.current.type === 'selectionDrag') {
          const dx = snap(wx - touchStateRef.current.lastWorldX);
          const dy = snap(wy - touchStateRef.current.lastWorldY);
          if (dx !== 0 || dy !== 0) {
            onMoveSelection(dx, dy);
            touchStateRef.current.lastWorldX += dx;
            touchStateRef.current.lastWorldY += dy;
          }
        } else if (touchStateRef.current.type === 'rectSelect') {
          touchStateRef.current.moved = true;
          const currentWorld = { x: wx, y: wy };
          const startWorld = touchStateRef.current.startWorld;
          const rx = Math.min(startWorld.x, currentWorld.x);
          const ry = Math.min(startWorld.y, currentWorld.y);
          const rw = Math.abs(currentWorld.x - startWorld.x);
          const rh = Math.abs(currentWorld.y - startWorld.y);
          setSelectRect({ x: rx, y: ry, w: rw, h: rh });

          // Compute selection
          const selRect = { x: rx, y: ry, w: rw, h: rh };
          const currentNodes = nodesRef.current;
          const currentArrows = arrowsRef.current;
          const currentStrokes = drawStrokesRef.current || [];
          const hm = nodeHeightRef.current;

          const selNodeIds = new Set();
          const selStrokeIds = new Set();
          const selArrowIds = new Set();

          for (const node of Object.values(currentNodes)) {
            const nw = node.width || 220;
            const nh = (hm && hm[node.id]) || 60;
            const nodeRect = { x: node.x, y: node.y, w: nw, h: nh };
            if (rectsOverlap(selRect, nodeRect)) {
              selNodeIds.add(node.id);
            }
          }

          for (const stroke of currentStrokes) {
            if (stroke.points && stroke.points.some(p => p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh)) {
              selStrokeIds.add(stroke.id);
            }
          }

          for (const [aId, arrow] of Object.entries(currentArrows)) {
            if (selNodeIds.has(arrow.fromNodeId) || selNodeIds.has(arrow.toNodeId)) {
              selArrowIds.add(aId);
            }
          }

          onSelectionChange({ nodeIds: selNodeIds, arrowIds: selArrowIds, strokeIds: selStrokeIds });
        } else if (touchStateRef.current.type === 'arrow-preview') {
          touchStateRef.current.moved = true;
          const currentNodes = nodesRef.current;
          const hm = nodeHeightRef.current;
          let snapNodeId = null;
          let snapAnchor = null;
          const SNAP_DIST = 30;
          for (const nid of Object.keys(currentNodes)) {
            if (nid === touchStateRef.current.fromNodeId) continue;
            const { anchor, dist } = closestAnchor(currentNodes[nid], wx, wy, hm);
            if (dist < SNAP_DIST) {
              snapNodeId = nid;
              snapAnchor = anchor;
              break;
            }
          }
          setArrowPreview({
            fromNodeId: touchStateRef.current.fromNodeId,
            fromAnchor: touchStateRef.current.fromAnchor,
            cursorX: wx,
            cursorY: wy,
            snapNodeId,
            snapAnchor,
          });
        } else if (touchStateRef.current.type === 'pan') {
          const dx = t.clientX - touchStateRef.current.lastX;
          const dy = t.clientY - touchStateRef.current.lastY;
          if (!touchStateRef.current.moved && Math.abs(t.clientX - touchStateRef.current.startX) < 4 && Math.abs(t.clientY - touchStateRef.current.startY) < 4) return;
          touchStateRef.current.moved = true;
          touchStateRef.current.lastX = t.clientX;
          touchStateRef.current.lastY = t.clientY;
          onUpdateViewport({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy });
        } else if (touchStateRef.current.type === 'pinch') {
          // Went from 2 fingers to 1 -- switch to pan
          touchStateRef.current = { type: 'pan', lastX: t.clientX, lastY: t.clientY, startX: t.clientX, startY: t.clientY, moved: false };
        }
      }
    }

    function onTouchEnd(e) {
      if (!touchStateRef.current) return;

      if (e.touches.length === 0) {
        if (touchStateRef.current.type === 'draw') {
          if (currentStroke.current && currentStroke.current.points.length > 1 && onAddStroke) {
            onAddStroke({ ...currentStroke.current });
          }
          currentStroke.current = null;
          setDrawingPreview(null);
        }
        if (touchStateRef.current.type === 'erase') {
          setEraserCursor(null);
        }
        if (touchStateRef.current.type === 'node-drag') {
          setDraggingNodeId(null);
          if (onNodeDragEnd) onNodeDragEnd();
          // Tap on node (no drag movement): select it, tap again -> edit
          if (!touchStateRef.current.moved) {
            const nodeId = touchStateRef.current.nodeId;
            // If already selected, start editing — programmatically focus the text
            if (selectedIdRef.current === nodeId) {
              setEditingNodeId(nodeId);
              editingRef.current = nodeId;
              // Focus the contentEditable text to open keyboard
              const nodeEl = nodeElsRef.current[nodeId];
              if (nodeEl) {
                const textEl = nodeEl.querySelector('.node-text');
                if (textEl) textEl.focus();
              }
            } else {
              onSelect(nodeId, 'node');
            }
          }
        }
        if (touchStateRef.current.type === 'selectionDrag') {
          if (onSelectionDragEnd) onSelectionDragEnd();
        }
        if (touchStateRef.current.type === 'rectSelect') {
          setSelectRect(null);
          if (!touchStateRef.current.moved) {
            // Simple tap on background: deselect
            onSelect(null, null);
            onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
          }
        }
        if (touchStateRef.current.type === 'arrow-preview') {
          // Complete arrow creation if snapped
          setArrowPreview((prev) => {
            if (prev && prev.snapNodeId && prev.snapAnchor) {
              onAddArrow(prev.fromNodeId, prev.fromAnchor, prev.snapNodeId, prev.snapAnchor);
            }
            return null;
          });
        }
        if (touchStateRef.current.type === 'pan' && !touchStateRef.current.moved) {
          onSelect(null, null);
        }
        touchStateRef.current = null;
      } else if (e.touches.length === 1 && touchStateRef.current.type === 'pinch') {
        const t = e.touches[0];
        touchStateRef.current = { type: 'pan', lastX: t.clientX, lastY: t.clientY, startX: t.clientX, startY: t.clientY, moved: false };
      }
    }

    function onTouchCancel(e) {
      // For erase mode, ignore cancel — DOM mutations from deleting nodes can
      // trigger touchcancel, but we want to keep erasing on continued touch.
      if (touchStateRef.current && touchStateRef.current.type === 'erase') return;
      onTouchEnd(e);
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchCancel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [isMobile, onUpdateViewport, onUpdateNode, onAddStroke, onAddArrow, onSelect, onNodeDragEnd, onSelectionDragEnd, onMoveSelection, onSelectionChange, screenToWorld]);

  /* ================================================================
     Mouse down on canvas background -> pan, draw, erase, or rect select
     ================================================================ */
  // Keep refs to current tool props for event handlers
  const toolModeRef = useRef(toolMode);
  useEffect(() => { toolModeRef.current = toolMode; }, [toolMode]);
  const eraserModeRef = useRef(eraserMode);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  const eraserRadiusRef = useRef(eraserRadius);
  useEffect(() => { eraserRadiusRef.current = eraserRadius; }, [eraserRadius]);
  const drawStrokesRef = useRef(drawStrokes);
  useEffect(() => { drawStrokesRef.current = drawStrokes; }, [drawStrokes]);

  /* ---- Eraser perform ref (set below, used in event handlers) ---- */
  const performEraseRef = useRef(null);
  const onUpdateRegionRef = useRef(onUpdateRegion);
  useEffect(() => { onUpdateRegionRef.current = onUpdateRegion; }, [onUpdateRegion]);
  const onRegionDragEndRef = useRef(onRegionDragEnd);
  useEffect(() => { onRegionDragEndRef.current = onRegionDragEnd; }, [onRegionDragEnd]);

  const onCanvasMouseDown = useCallback((e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const isBackground = e.target === rootRef.current || e.target.classList.contains('canvas-grid') || e.target.classList.contains('canvas-transform') || e.target.classList.contains('drawing-layer') || e.target.classList.contains('eraser-hit-layer') || e.target.classList.contains('select-hit-layer');

    if (!isBackground) return;

    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);

    if (toolMode === 'draw') {
      // Start freehand drawing
      e.preventDefault();
      currentStroke.current = { points: [{ x: world.x, y: world.y }], color: drawColor || '#6c8cff', width: drawWidth || 2 };
      dragState.current = { type: 'draw' };
      setDrawingPreview(pointsToPath([{ x: world.x, y: world.y }]));
      return;
    }

    if (toolMode === 'eraser') {
      e.preventDefault();
      dragState.current = { type: 'erase' };
      setEraserCursor(world);
      // Perform initial erase at click position
      if (performEraseRef.current) performEraseRef.current(world.x, world.y);
      return;
    }

    // Move mode: always pan
    if (toolMode === 'move') {
      e.preventDefault();
      rootRef.current?.classList.add('panning');
      dragState.current = {
        type: 'pan',
        startX: mx,
        startY: my,
        startPanX: vpRef.current.panX,
        startPanY: vpRef.current.panY,
      };
      return;
    }

    // Select mode: check if clicking on empty space -> start rect selection or pan
    if (toolMode === 'select') {
      // Check if click is inside selection bounding box (for stroke-only selection drag)
      const sel = selection;
      const selBounds = getSelectionBounds(sel, nodesRef.current, drawStrokesRef.current, nodeHeightRef.current);
      if ((sel.nodeIds.size > 0 || sel.strokeIds.size > 0) && selBounds &&
          world.x >= selBounds.x && world.x <= selBounds.x + selBounds.w &&
          world.y >= selBounds.y && world.y <= selBounds.y + selBounds.h) {
        e.preventDefault();
        dragState.current = {
          type: 'selectionDrag',
          startWorldX: world.x,
          startWorldY: world.y,
          lastWorldX: world.x,
          lastWorldY: world.y,
        };
        return;
      }

      // Clear selection and single-select
      onSelect(null, null);
      onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });

      // Start rectangle selection
      e.preventDefault();
      dragState.current = {
        type: 'rectSelect',
        startWorld: world,
        startScreen: { x: mx, y: my },
        startPanX: vpRef.current.panX,
        startPanY: vpRef.current.panY,
        moved: false,
      };
      return;
    }
  }, [onSelect, toolMode, drawColor, drawWidth, screenToWorld, onSelectionChange, selection]);

  /* ================================================================
     Eraser perform helper
     ================================================================ */
  const performErase = useCallback((wx, wy) => {
    // Convert screen-pixel radius to world units
    const radius = eraserRadiusRef.current / vpRef.current.zoom;
    const mode = eraserModeRef.current;

    if (mode === 'object') {
      const currentNodes = nodesRef.current;
      const currentArrows = arrowsRef.current;
      const currentStrokes = drawStrokesRef.current || [];
      const hm = nodeHeightRef.current;

      const hitNodeIds = [];
      const hitArrowIds = [];
      const hitStrokeIds = [];

      for (const node of Object.values(currentNodes)) {
        if (nodeHitsCircle(node, wx, wy, radius, hm)) {
          hitNodeIds.push(node.id);
        }
      }
      for (const [aId, arrow] of Object.entries(currentArrows)) {
        if (arrowHitsCircle(arrow, currentNodes, wx, wy, radius, hm)) {
          hitArrowIds.push(aId);
        }
      }
      for (const stroke of currentStrokes) {
        if (strokeHitsCircle(stroke, wx, wy, radius)) {
          hitStrokeIds.push(stroke.id);
        }
      }

      if (hitNodeIds.length || hitArrowIds.length || hitStrokeIds.length) {
        onEraseObjects({ nodeIds: hitNodeIds, arrowIds: hitArrowIds, strokeIds: hitStrokeIds });
      }
    } else {
      // Pixel erase
      const currentStrokes = drawStrokesRef.current || [];
      const { strokes: newStrokes, changed } = pixelEraseStrokes(currentStrokes, wx, wy, radius);
      if (changed) {
        onPixelErase(newStrokes);
      }
    }
  }, [onEraseObjects, onPixelErase]);

  performEraseRef.current = performErase;

  /* ================================================================
     Mouse down on a node -> start dragging it (or selection drag)
     ================================================================ */
  const onNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return;
    if (e.target.classList.contains('node-text') && e.target.contentEditable === 'true') return;
    if (toolMode === 'eraser') return; // Don't drag in eraser mode
    e.stopPropagation();

    // If this node is part of a multi-selection, start group drag
    if (selection.nodeIds.has(nodeId) && selection.nodeIds.size > 0) {
      const rect = rootRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const world = screenToWorld(mx, my);
      dragState.current = {
        type: 'selectionDrag',
        startWorldX: world.x,
        startWorldY: world.y,
        lastWorldX: world.x,
        lastWorldY: world.y,
      };
      return;
    }

    onSelect(nodeId, 'node');
    // Clear rect selection when clicking individual node
    onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    const node = nodes[nodeId];
    if (!node) return;
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    dragState.current = {
      type: 'node',
      nodeId,
      offsetX: world.x - node.x,
      offsetY: world.y - node.y,
    };
    setDraggingNodeId(nodeId);
  }, [nodes, onSelect, screenToWorld, toolMode, selection, onSelectionChange]);

  /* ================================================================
     Mouse down on an anchor dot -> start arrow creation
     ================================================================ */
  const onAnchorMouseDown = useCallback((e, nodeId, anchor) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    dragState.current = {
      type: 'arrow',
      fromNodeId: nodeId,
      fromAnchor: anchor,
    };
    setArrowPreview({
      fromNodeId: nodeId,
      fromAnchor: anchor,
      cursorX: world.x,
      cursorY: world.y,
      snapNodeId: null,
      snapAnchor: null,
    });
  }, [screenToWorld]);

  /* ================================================================
     Mouse down on region border -> start dragging or resizing region
     ================================================================ */
  const onRegionBorderMouseDown = useCallback((e, regionId) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(regionId, 'region');
    const region = regions[regionId];
    if (!region) return;
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    dragState.current = {
      type: 'regionDrag',
      regionId,
      offsetX: world.x - region.x,
      offsetY: world.y - region.y,
    };
  }, [regions, onSelect, screenToWorld]);

  const onRegionResizeMouseDown = useCallback((e, regionId, corner) => {
    e.stopPropagation();
    e.preventDefault();
    const region = regions[regionId];
    if (!region) return;
    dragState.current = {
      type: 'regionResize',
      regionId,
      corner,
      startX: region.x,
      startY: region.y,
      startW: region.w,
      startH: region.h,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
    };
  }, [regions]);

  /* ================================================================
     Mouse down on a resize handle -> start resizing node
     ================================================================ */
  const onResizeMouseDown = useCallback((e, nodeId, corner) => {
    e.stopPropagation();
    e.preventDefault();
    const node = nodes[nodeId];
    if (!node) return;
    dragState.current = {
      type: 'resize',
      nodeId,
      corner, // 'se' | 'sw' | 'ne' | 'nw'
      startX: node.x,
      startY: node.y,
      startW: node.width || 220,
      startH: nodeHeightRef.current[nodeId] || 60,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
    };
  }, [nodes]);

  /* ================================================================
     Global mousemove / mouseup
     ================================================================ */
  // We need stable refs to state for use in the mousemove handler
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  const arrowsRef = useRef(arrows);
  useEffect(() => { arrowsRef.current = arrows; }, [arrows]);

  useEffect(() => {
    function onMouseMove(e) {
      const ds = dragState.current;

      // Update eraser cursor position even when not dragging
      if (toolModeRef.current === 'eraser' && rootRef.current) {
        const rect = rootRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const vp = vpRef.current;
        setEraserCursor({
          x: (mx - vp.panX) / vp.zoom,
          y: (my - vp.panY) / vp.zoom,
        });
      }

      if (!ds) return;

      const rect = rootRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (ds.type === 'draw') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        if (currentStroke.current) {
          currentStroke.current.points.push({ x: worldX, y: worldY });
          setDrawingPreview(pointsToPath(currentStroke.current.points));
        }
        return;
      }

      if (ds.type === 'erase') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        setEraserCursor({ x: worldX, y: worldY });
        performEraseRef.current(worldX, worldY);
        return;
      }

      if (ds.type === 'rectSelect') {
        ds.moved = true;
        const vp = vpRef.current;
        const currentWorld = {
          x: (mx - vp.panX) / vp.zoom,
          y: (my - vp.panY) / vp.zoom,
        };
        const startWorld = ds.startWorld;
        const rx = Math.min(startWorld.x, currentWorld.x);
        const ry = Math.min(startWorld.y, currentWorld.y);
        const rw = Math.abs(currentWorld.x - startWorld.x);
        const rh = Math.abs(currentWorld.y - startWorld.y);
        setSelectRect({ x: rx, y: ry, w: rw, h: rh });

        // Compute selection
        const selRect = { x: rx, y: ry, w: rw, h: rh };
        const currentNodes = nodesRef.current;
        const currentArrows = arrowsRef.current;
        const currentStrokes = drawStrokesRef.current || [];
        const hm = nodeHeightRef.current;

        const selNodeIds = new Set();
        const selStrokeIds = new Set();
        const selArrowIds = new Set();

        for (const node of Object.values(currentNodes)) {
          const nw = node.width || 220;
          const nh = (hm && hm[node.id]) || 60;
          const nodeRect = { x: node.x, y: node.y, w: nw, h: nh };
          if (rectsOverlap(selRect, nodeRect)) {
            selNodeIds.add(node.id);
          }
        }

        for (const stroke of currentStrokes) {
          if (stroke.points && stroke.points.some(p => p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh)) {
            selStrokeIds.add(stroke.id);
          }
        }

        // Select arrows connected to selected nodes
        for (const [aId, arrow] of Object.entries(currentArrows)) {
          if (selNodeIds.has(arrow.fromNodeId) || selNodeIds.has(arrow.toNodeId)) {
            selArrowIds.add(aId);
          }
        }

        onSelectionChange({ nodeIds: selNodeIds, arrowIds: selArrowIds, strokeIds: selStrokeIds });
        return;
      }

      if (ds.type === 'selectionDrag') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const dx = snap(worldX - ds.lastWorldX);
        const dy = snap(worldY - ds.lastWorldY);
        if (dx !== 0 || dy !== 0) {
          onMoveSelection(dx, dy);
          ds.lastWorldX += dx;
          ds.lastWorldY += dy;
        }
        return;
      }

      if (ds.type === 'pan') {
        if (panRAF.current) cancelAnimationFrame(panRAF.current);
        panRAF.current = requestAnimationFrame(() => {
          const dx = mx - ds.startX;
          const dy = my - ds.startY;
          onUpdateViewport({
            ...vpRef.current,
            panX: ds.startPanX + dx,
            panY: ds.startPanY + dy,
          });
        });
      } else if (ds.type === 'node') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const newX = snap(worldX - ds.offsetX);
        const newY = snap(worldY - ds.offsetY);
        onUpdateNode(ds.nodeId, { x: newX, y: newY });
      } else if (ds.type === 'arrow') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const currentNodes = nodesRef.current;
        const hm = nodeHeightRef.current;
        let snapNodeId = null;
        let snapAnchor = null;
        const SNAP_DIST = 30;
        for (const nid of Object.keys(currentNodes)) {
          if (nid === ds.fromNodeId) continue;
          const { anchor, dist } = closestAnchor(currentNodes[nid], worldX, worldY, hm);
          if (dist < SNAP_DIST) {
            snapNodeId = nid;
            snapAnchor = anchor;
            break;
          }
        }
        setArrowPreview({
          fromNodeId: ds.fromNodeId,
          fromAnchor: ds.fromAnchor,
          cursorX: worldX,
          cursorY: worldY,
          snapNodeId,
          snapAnchor,
        });
      } else if (ds.type === 'resize') {
        const vp = vpRef.current;
        const dx = (e.clientX - ds.startMouseX) / vp.zoom;
        const dy = (e.clientY - ds.startMouseY) / vp.zoom;
        const MIN_W = 60;
        const MIN_H = 40;
        // Right/bottom edge: startX stays fixed, width grows
        // Left/top edge: far edge stays fixed, position adjusts
        const farR = ds.startX + ds.startW;
        const farB = ds.startY + ds.startH;

        let newW = ds.startW, newH = ds.startH, newX = ds.startX, newY = ds.startY;

        if (ds.corner === 'se') {
          newW = snap(Math.max(MIN_W, ds.startW + dx));
          newH = snap(Math.max(MIN_H, ds.startH + dy));
        } else if (ds.corner === 'sw') {
          newW = snap(Math.max(MIN_W, ds.startW - dx));
          newH = snap(Math.max(MIN_H, ds.startH + dy));
          newX = farR - newW; // far-right edge stays fixed
        } else if (ds.corner === 'ne') {
          newW = snap(Math.max(MIN_W, ds.startW + dx));
          newH = snap(Math.max(MIN_H, ds.startH - dy));
          newY = farB - newH; // far-bottom edge stays fixed
        } else if (ds.corner === 'nw') {
          newW = snap(Math.max(MIN_W, ds.startW - dx));
          newH = snap(Math.max(MIN_H, ds.startH - dy));
          newX = farR - newW;
          newY = farB - newH;
        }

        onUpdateNode(ds.nodeId, { x: newX, y: newY, width: newW });
        nodeHeightRef.current[ds.nodeId] = newH;
        setNodeHeightMap(prev => ({ ...prev, [ds.nodeId]: newH }));
      } else if (ds.type === 'regionDrag') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        onUpdateRegionRef.current(ds.regionId, { x: snap(worldX - ds.offsetX), y: snap(worldY - ds.offsetY) });
      } else if (ds.type === 'regionResize') {
        const vp = vpRef.current;
        const dx = (e.clientX - ds.startMouseX) / vp.zoom;
        const dy = (e.clientY - ds.startMouseY) / vp.zoom;
        const MIN_S = 60;
        const farR = ds.startX + ds.startW;
        const farB = ds.startY + ds.startH;
        let newW = ds.startW, newH = ds.startH, newX = ds.startX, newY = ds.startY;
        if (ds.corner === 'se') { newW = snap(Math.max(MIN_S, ds.startW + dx)); newH = snap(Math.max(MIN_S, ds.startH + dy)); }
        else if (ds.corner === 'sw') { newW = snap(Math.max(MIN_S, ds.startW - dx)); newH = snap(Math.max(MIN_S, ds.startH + dy)); newX = farR - newW; }
        else if (ds.corner === 'ne') { newW = snap(Math.max(MIN_S, ds.startW + dx)); newH = snap(Math.max(MIN_S, ds.startH - dy)); newY = farB - newH; }
        else if (ds.corner === 'nw') { newW = snap(Math.max(MIN_S, ds.startW - dx)); newH = snap(Math.max(MIN_S, ds.startH - dy)); newX = farR - newW; newY = farB - newH; }
        onUpdateRegionRef.current(ds.regionId, { x: newX, y: newY, w: newW, h: newH });
      }
    }

    function onMouseUp() {
      const ds = dragState.current;
      if (ds && ds.type === 'draw') {
        if (currentStroke.current && currentStroke.current.points.length > 1 && onAddStroke) {
          onAddStroke({ ...currentStroke.current });
        }
        currentStroke.current = null;
        setDrawingPreview(null);
      }
      if (ds && ds.type === 'pan') {
        rootRef.current?.classList.remove('panning');
      }
      if (ds && ds.type === 'node') {
        setDraggingNodeId(null);
        onNodeDragEnd();
      }
      if (ds && ds.type === 'erase') {
        // Erase done
      }
      if (ds && ds.type === 'rectSelect') {
        setSelectRect(null);
        // If user didn't move, it was a click on empty space -> already cleared selection
        if (!ds.moved) {
          // Start panning instead
        }
      }
      if (ds && ds.type === 'selectionDrag') {
        onSelectionDragEnd();
      }
      if (ds && ds.type === 'resize') {
        onNodeDragEnd(); // push history snapshot
      }
      if (ds && (ds.type === 'regionDrag' || ds.type === 'regionResize')) {
        onRegionDragEndRef.current();
      }
      if (ds && ds.type === 'arrow') {
        setArrowPreview((prev) => {
          if (prev && prev.snapNodeId && prev.snapAnchor) {
            onAddArrow(prev.fromNodeId, prev.fromAnchor, prev.snapNodeId, prev.snapAnchor);
          }
          return null;
        });
      }
      dragState.current = null;
      if (panRAF.current) {
        cancelAnimationFrame(panRAF.current);
        panRAF.current = null;
      }
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onUpdateViewport, onUpdateNode, onAddArrow, onAddStroke, onMoveSelection, onSelectionDragEnd, onNodeDragEnd, onSelectionChange]);

  /* ================================================================
     Handle mouse leaving canvas - hide eraser cursor
     ================================================================ */
  const onCanvasMouseLeave = useCallback(() => {
    if (toolMode === 'eraser') {
      setEraserCursor(null);
    }
  }, [toolMode]);

  /* ================================================================
     Double-click on background -> create node
     ================================================================ */
  const onCanvasDoubleClick = useCallback((e) => {
    if (e.target !== rootRef.current && !e.target.classList.contains('canvas-grid') && !e.target.classList.contains('canvas-transform') && !e.target.classList.contains('select-hit-layer')) return;
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    onAddNode(snap(world.x - 110), snap(world.y - 30));
  }, [screenToWorld, onAddNode]);

  /* ================================================================
     Click on arrow -> select it
     ================================================================ */
  const onArrowClick = useCallback((e, arrowId) => {
    e.stopPropagation();
    onSelect(arrowId, 'arrow');
  }, [onSelect]);

  /* ================================================================
     Double-click on arrow -> edit label
     ================================================================ */
  const [editingArrowId, setEditingArrowId] = useState(null);

  const onArrowDoubleClick = useCallback((e, arrowId) => {
    e.stopPropagation();
    onSelect(arrowId, 'arrow');
    setEditingArrowId(arrowId);
  }, [onSelect]);

  const onArrowLabelBlur = useCallback((e, arrowId) => {
    const label = e.target.innerText.trim();
    if (onUpdateArrow) onUpdateArrow(arrowId, { label });
    setEditingArrowId(null);
  }, [onUpdateArrow]);

  const onArrowLabelKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      setEditingArrowId(null);
      e.target.blur();
    }
  }, []);

  /* ================================================================
     Node text editing
     ================================================================ */
  const editingRef = useRef(null);
  const [editingNodeId, setEditingNodeId] = useState(null);

  const onTextClick = useCallback((e, nodeId) => {
    e.stopPropagation();
    onSelect(nodeId, 'node');
    setEditingNodeId(nodeId);
    editingRef.current = nodeId;
  }, [onSelect]);

  const onTextBlur = useCallback((e, nodeId) => {
    const text = e.target.innerText.trim();
    onUpdateNode(nodeId, { text });
    // Push history after text edit (onUpdateNode doesn't push history)
    if (onNodeDragEnd) onNodeDragEnd();
    if (editingRef.current === nodeId) {
      setEditingNodeId(null);
      editingRef.current = null;
    }
  }, [onUpdateNode, onNodeDragEnd]);

  const onTextKeyDown = useCallback((e, nodeId) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      e.target.innerText = nodes[nodeId]?.text || '';
      setEditingNodeId(null);
      editingRef.current = null;
      e.target.blur();
    }
  }, [nodes]);

  /* ================================================================
     Measure node heights after render
     ================================================================ */
  const nodeElsRef = useRef({});

  const registerNodeEl = useCallback((nodeId, el) => {
    if (el) {
      nodeElsRef.current[nodeId] = el;
    } else {
      delete nodeElsRef.current[nodeId];
    }
  }, []);

  const measureAllNodes = useCallback(() => {
    const newMap = {};
    let changed = false;
    const nodeIds = Object.keys(nodesRef.current);
    for (const id of nodeIds) {
      const el = nodeElsRef.current[id];
      if (el) {
        const natural = el.offsetHeight;
        const snapped = Math.max(60, Math.ceil(natural / GRID_SIZE) * GRID_SIZE);
        newMap[id] = snapped;
        if (nodeHeightRef.current[id] !== snapped) {
          changed = true;
        }
      } else {
        newMap[id] = nodeHeightRef.current[id] || 60;
      }
    }
    for (const id of Object.keys(nodeHeightRef.current)) {
      if (!nodesRef.current[id]) {
        changed = true;
      }
    }
    if (changed) {
      nodeHeightRef.current = newMap;
      setNodeHeightMap(newMap);
    }
  }, []);

  // Use ResizeObserver to detect node size changes and re-measure
  const resizeObserverRef = useRef(null);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      measureAllNodes();
    });
    resizeObserverRef.current = ro;

    // Observe all currently registered node elements
    for (const el of Object.values(nodeElsRef.current)) {
      ro.observe(el);
    }

    return () => ro.disconnect();
  }, [measureAllNodes]);

  // Re-observe when nodes change (new nodes added or removed)
  useEffect(() => {
    const ro = resizeObserverRef.current;
    if (!ro) return;
    // Re-observe all current elements
    ro.disconnect();
    for (const el of Object.values(nodeElsRef.current)) {
      ro.observe(el);
    }
    // Trigger measurement via a microtask (not synchronous in effect body)
    queueMicrotask(() => measureAllNodes());
  }, [nodes, measureAllNodes]);

  /* ================================================================
     Render helpers
     ================================================================ */
  // Cache rendered LaTeX HTML — only recompute when node text changes, not on every pan/zoom
  const latexCache = useMemo(() => {
    const cache = {};
    for (const node of Object.values(nodes)) {
      if (hasLatex(node.text)) {
        cache[node.id] = renderLatexToHtml(node.text).html;
      }
    }
    return cache;
  }, [nodes]);

  const { panX, panY, zoom } = viewport;
  const gridSize = GRID_SIZE * zoom;

  /* ---- Render arrows (SVG) ---- */
  const arrowSize = zoom < 0.4 ? 16 : 10; // bigger arrowheads at overview zoom
  const arrowElements = [];
  for (const aId of Object.keys(arrows)) {
    const arrow = arrows[aId];
    const fromNode = nodes[arrow.fromNodeId];
    const toNode = nodes[arrow.toNodeId];
    if (!fromNode || !toNode) continue;

    const from = getAnchorPos(fromNode, arrow.fromAnchor, nodeHeightMap);
    const to = getAnchorPos(toNode, arrow.toAnchor, nodeHeightMap);
    const { path, cp2x, cp2y, midX, midY } = bezierPath(from.x, from.y, arrow.fromAnchor, to.x, to.y, arrow.toAnchor);
    const color = arrow.color || '#6c8cff';
    const isSelected = selectedType === 'arrow' && selectedId === aId;
    const isInSelection = selection.arrowIds.has(aId);
    const isEditingLabel = editingArrowId === aId;
    const hasLabel = arrow.label && arrow.label.trim();

    arrowElements.push(
      <g key={aId} style={{ color }}>
        <path
          d={path}
          className="arrow-path-hit"
          onClick={(e) => onArrowClick(e, aId)}
          onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
        />
        <path
          d={path}
          className={`arrow-path${isSelected || isInSelection ? ' selected' : ''}`}
          stroke={color}
          onClick={(e) => onArrowClick(e, aId)}
          onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
        />
        <polygon
          points={arrowheadPoints(to.x, to.y, cp2x, cp2y, arrowSize)}
          className="arrow-marker"
          style={{ color }}
          fill={color}
        />
        {/* Arrow label */}
        {(hasLabel || isEditingLabel) && (
          <foreignObject
            x={midX - 84} y={midY - 30}
            width={168} height={60}
            style={{ overflow: 'visible' }}
          >
            <div
              className={`arrow-label${isEditingLabel ? ' editing' : ''}`}
              contentEditable={isEditingLabel}
              suppressContentEditableWarning
              onBlur={(e) => onArrowLabelBlur(e, aId)}
              onKeyDown={onArrowLabelKeyDown}
              onInput={() => {}}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => { e.stopPropagation(); onArrowDoubleClick(e, aId); }}
              ref={(el) => { if (el && isEditingLabel) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } }}
            >
              {arrow.label || ''}
            </div>
          </foreignObject>
        )}
      </g>
    );
  }

  /* ---- Preview arrow while dragging ---- */
  if (arrowPreview) {
    const fromNode = nodes[arrowPreview.fromNodeId];
    if (fromNode) {
      const from = getAnchorPos(fromNode, arrowPreview.fromAnchor, nodeHeightMap);
      let ex, ey, toAnchor;
      if (arrowPreview.snapNodeId && arrowPreview.snapAnchor) {
        const toNode = nodes[arrowPreview.snapNodeId];
        if (toNode) {
          const to = getAnchorPos(toNode, arrowPreview.snapAnchor, nodeHeightMap);
          ex = to.x;
          ey = to.y;
          toAnchor = arrowPreview.snapAnchor;
        }
      }
      if (ex === undefined) {
        ex = arrowPreview.cursorX;
        ey = arrowPreview.cursorY;
        const dx = ex - from.x;
        const dy = ey - from.y;
        if (Math.abs(dx) > Math.abs(dy)) {
          toAnchor = dx > 0 ? 'left' : 'right';
        } else {
          toAnchor = dy > 0 ? 'top' : 'bottom';
        }
      }
      const { path, cp2x, cp2y } = bezierPath(from.x, from.y, arrowPreview.fromAnchor, ex, ey, toAnchor);
      arrowElements.push(
        <g key="__preview__" style={{ color: '#6c8cff' }}>
          <path d={path} className="arrow-path preview" stroke="#6c8cff" />
          <polygon
            points={arrowheadPoints(ex, ey, cp2x, cp2y, 8)}
            fill="#6c8cff"
            opacity={0.6}
          />
        </g>
      );
    }
  }

  /* ---- Render nodes ---- */
  const nodeElements = Object.values(nodes).map((node) => {
    const isSelected = selectedType === 'node' && selectedId === node.id;
    const isEditing = editingNodeId === node.id;
    const isDragging = draggingNodeId === node.id;
    const isInSelection = selection.nodeIds.has(node.id);
    const color = node.color || '#6c8cff';
    const height = nodeHeightMap[node.id] || 60;

    return (
      <div
        key={node.id}
        ref={(el) => registerNodeEl(node.id, el)}
        className={`wb-node${node.style === 'text' ? ' text-node' : ''}${isSelected ? ' selected' : ''}${isDragging ? ' dragging' : ''}${isInSelection ? ' in-selection' : ''}`}
        style={{
          left: node.x,
          top: node.y,
          width: node.width || 220,
          minHeight: node.style === 'text' ? 20 : height,
          borderColor: node.style === 'text' ? 'transparent' : color,
          boxShadow: node.style === 'text' ? 'none' : `0 0 ${isSelected || isInSelection ? 20 : 12}px ${isSelected || isInSelection ? 4 : 2}px ${color}22, inset 0 0 ${isSelected || isInSelection ? 16 : 8}px ${color}08`,
        }}
        onMouseDown={(e) => onNodeMouseDown(e, node.id)}
      >
        {/* LaTeX rendered view: show when not editing and not in source mode and text has LaTeX */}
        {!isEditing && !sourceMode && latexCache[node.id] ? (
          <span
            className="node-text node-text-rendered"
            style={{ textAlign: node.align || 'center' }}
            onClick={(e) => onTextClick(e, node.id)}
            dangerouslySetInnerHTML={{ __html: latexCache[node.id] }}
          />
        ) : (
          <span
            className="node-text"
            style={{ textAlign: node.align || 'center' }}
            contentEditable={isMobile || isEditing}
            suppressContentEditableWarning
            readOnly={isMobile && !isEditing ? true : undefined}
            onClick={(e) => onTextClick(e, node.id)}
            onFocus={() => { if (isMobile) { onSelect(node.id, 'node'); setEditingNodeId(node.id); editingRef.current = node.id; } }}
            onBlur={(e) => onTextBlur(e, node.id)}
            onKeyDown={(e) => onTextKeyDown(e, node.id)}
            onInput={(e) => {
              const el = e.target.closest('.wb-node');
              if (el) {
                el.style.minHeight = 'auto';
                const natural = el.offsetHeight;
                const snapped = Math.max(60, Math.ceil(natural / GRID_SIZE) * GRID_SIZE);
                el.style.minHeight = snapped + 'px';
                nodeHeightRef.current[node.id] = snapped;
                setNodeHeightMap((prev) => ({ ...prev, [node.id]: snapped }));
              }
            }}
          >
            {node.text}
          </span>
        )}

        {node.style !== 'text' && ANCHORS.map((a) => (
          <div
            key={a}
            className={`anchor-dot ${a}`}
            style={{ background: color }}
            onMouseDown={(e) => onAnchorMouseDown(e, node.id, a)}
          />
        ))}

        {/* Resize handles - shown when selected */}
        {(isSelected || isInSelection) && ['nw', 'ne', 'sw', 'se'].map((corner) => (
          <div
            key={corner}
            className={`resize-handle ${corner}`}
            onMouseDown={(e) => onResizeMouseDown(e, node.id, corner)}
          />
        ))}
      </div>
    );
  });

  const isOverview = viewport.zoom < 0.4;

  // Determine cursor class based on tool mode
  const cursorClass = toolMode === 'draw' ? ' draw-mode'
    : toolMode === 'eraser' ? ' eraser-mode'
    : toolMode === 'move' ? ' move-mode'
    : '';

  // Compute stroke selection bounding box for visual indicator
  const strokeSelBounds = (selection.strokeIds.size > 0)
    ? getSelectionBounds({ nodeIds: new Set(), strokeIds: selection.strokeIds }, {}, drawStrokes, nodeHeightMap)
    : null;

  return (
    <div
      ref={rootRef}
      className={`canvas-root${isOverview ? ' overview' : ''}${cursorClass}`}
      onMouseDown={onCanvasMouseDown}
      onDoubleClick={toolMode === 'select' ? onCanvasDoubleClick : undefined}
      onMouseLeave={onCanvasMouseLeave}
    >
      <div
        className="canvas-grid"
        style={{
          backgroundImage: `radial-gradient(circle at 0 0, rgba(255,255,255,0.07) 1px, transparent 1px)`,
          backgroundSize: `${gridSize}px ${gridSize}px`,
          backgroundPosition: `${panX % gridSize}px ${panY % gridSize}px`,
        }}
      />

      <div
        ref={transformRef}
        className="canvas-transform"
        style={{
          transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`,
        }}
      >
        {/* Regions layer — rendered below everything */}
        <div className="region-layer">
          {Object.values(regions).map((region) => {
            const isRegionSelected = selectedType === 'region' && selectedId === region.id;
            const color = region.color || '#6c8cff';
            return (
              <div
                key={region.id}
                className={`wb-region${isRegionSelected ? ' selected' : ''}`}
                style={{
                  left: region.x,
                  top: region.y,
                  width: region.w,
                  height: region.h,
                  '--region-color': color,
                }}
              >
                {/* Region label — above top-left corner */}
                <span
                  className="region-label"
                  contentEditable
                  suppressContentEditableWarning
                  style={{ color }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const text = e.target.textContent || '';
                    onUpdateRegionRef.current(region.id, { label: text });
                  }}
                >
                  {region.label || ''}
                </span>
                {/* Border hit area — selectable only by edge */}
                <div
                  className="region-border-hit"
                  onMouseDown={(e) => onRegionBorderMouseDown(e, region.id)}
                />
                {/* Resize handles when selected */}
                {isRegionSelected && ['nw', 'ne', 'sw', 'se'].map((corner) => (
                  <div
                    key={corner}
                    className={`resize-handle ${corner}`}
                    style={{ background: color }}
                    onMouseDown={(e) => onRegionResizeMouseDown(e, region.id, corner)}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <svg className="arrow-layer" width="20000" height="20000" viewBox="0 0 20000 20000">
          {arrowElements}
        </svg>

        <div className="node-layer">
          {nodeElements}
        </div>

        {/* Freehand drawing layer */}
        <svg className={`drawing-layer${toolMode === 'draw' ? ' active' : ''}`} width="1" height="1">
          {/* Persisted strokes */}
          {drawStrokes && drawStrokes.map((stroke) => (
            <path
              key={stroke.id}
              d={pointsToPath(stroke.points)}
              className={`freehand-stroke${selection.strokeIds.has(stroke.id) ? ' in-selection' : ''}`}
              stroke={stroke.color || '#6c8cff'}
              strokeWidth={stroke.width || 2}
            />
          ))}
          {/* Live preview while drawing */}
          {drawingPreview && currentStroke.current && (
            <path
              d={drawingPreview}
              className="freehand-stroke"
              stroke={currentStroke.current.color || '#6c8cff'}
              strokeWidth={currentStroke.current.width || 2}
              opacity={0.7}
            />
          )}
        </svg>

        {/* Eraser hit layer - catches mouse events in eraser mode */}
        {toolMode === 'eraser' && (
          <div className="eraser-hit-layer" />
        )}

        {/* Select hit layer - catches mouse events in select mode for rect selection */}
        {toolMode === 'select' && (
          <div className="select-hit-layer" />
        )}

        {/* Rectangle selection visual */}
        {selectRect && (
          <svg className="select-rect-layer" width="1" height="1">
            <rect
              x={selectRect.x}
              y={selectRect.y}
              width={selectRect.w}
              height={selectRect.h}
              className="selection-rect"
              strokeWidth={1 / zoom}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
            />
          </svg>
        )}

        {/* Stroke selection bounding box */}
        {strokeSelBounds && (
          <svg className="select-rect-layer" width="1" height="1">
            <rect
              x={strokeSelBounds.x - 4 / zoom}
              y={strokeSelBounds.y - 4 / zoom}
              width={strokeSelBounds.w + 8 / zoom}
              height={strokeSelBounds.h + 8 / zoom}
              className="stroke-selection-rect"
              fill="none"
              stroke="#6c8cff"
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${5 / zoom} ${3 / zoom}`}
              opacity={0.6}
            />
          </svg>
        )}

        {/* Eraser cursor circle - radius converted to world units */}
        {toolMode === 'eraser' && eraserCursor && (
          <svg className="eraser-cursor-layer" width="1" height="1">
            <circle
              cx={eraserCursor.x}
              cy={eraserCursor.y}
              r={eraserRadius / zoom}
              className="eraser-cursor"
              strokeWidth={1.5 / zoom}
            />
          </svg>
        )}
      </div>
    </div>
  );
}
