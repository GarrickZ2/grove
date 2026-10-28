import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Maximize2, Minus, Pause, Play, Plus } from "lucide-react";
import type { MemoryEntity, MemoryRelation } from "../../api/memory";
import { selectVisibleRelations } from "./memoryGraphRelations";
import { selectMemoryGraphTopology } from "./memoryGraphTopology";

const COLORS = ["#55b98b", "#b37ad9", "#e8bd58", "#e98273", "#69a8d8", "#8bc46b"];
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.2;
const DEFAULT_LINK_VISIBILITY_LIMIT = 24;
const TOPOLOGY_MAX_DEPTH = 3;
const TOPOLOGY_MAX_NODES = 18;
const TOPOLOGY_LABEL_LIMIT = 5;

interface SpatialNode {
  id: string;
  entity: MemoryEntity;
  color: string;
  radius: number;
  x: number;
  y: number;
  z: number;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  phase: number;
}

interface SpatialLink {
  relation: MemoryRelation;
  source: SpatialNode;
  target: SpatialNode;
  width: number;
  opacity: number;
}

interface SpatialScene {
  nodes: SpatialNode[];
  links: SpatialLink[];
  bounds: { x: number; y: number; z: number };
  spaceRadius: number;
}

interface ProjectedNode {
  node: SpatialNode;
  x: number;
  y: number;
  z: number;
  scale: number;
  radius: number;
}

interface ProjectedLink {
  link: SpatialLink;
  source: ProjectedNode;
  target: ProjectedNode;
  depth: number;
  width: number;
}

interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

interface HoverTarget {
  kind: "node" | "relation";
  id: string;
  x: number;
  y: number;
}

type PulseMode = "ambient" | "hover" | "pinned";

interface AmbientPulsePath {
  startedAt: number;
  hopDuration: number;
  intensity: number;
  hops: Array<{ relationId: string; reverse: boolean }>;
}

interface AmbientPulseRuntime {
  nextRoundAt: number;
  paths: AmbientPulsePath[];
}

interface DragState {
  pointerId: number;
  mode: "node" | "orbit" | "pan";
  startX: number;
  startY: number;
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  nodeId?: string;
  nodeX?: number;
  nodeY?: number;
  nodeZ?: number;
  moved: boolean;
}

export function MemoryGraph({
  entities,
  relations,
  onOpen,
  categoryColors,
  activeCategory,
  summary,
}: {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
  onOpen: (entityId: string) => void;
  categoryColors: ReadonlyMap<string, string>;
  activeCategory?: string | null;
  summary?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>(defaultCamera());
  const dragRef = useRef<DragState | null>(null);
  const projectedNodesRef = useRef<ProjectedNode[]>([]);
  const projectedLinksRef = useRef<ProjectedLink[]>([]);
  const hoverRef = useRef<HoverTarget | null>(null);
  const pinnedNodeIdRef = useRef<string | null>(null);
  const dirtyRef = useRef(true);
  const motionEnabledRef = useRef(true);
  const ambientPulseRef = useRef<AmbientPulseRuntime>({ nextRoundAt: 0, paths: [] });
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 720, height: 480 });

  const scene = useMemo(
    () => buildSpatialScene(entities, relations, categoryColors, activeCategory, containerSize),
    [activeCategory, categoryColors, containerSize, entities, relations],
  );
  const activeColor = activeCategory ? categoryColors.get(activeCategory) : undefined;

  useEffect(() => {
    motionEnabledRef.current = motionEnabled;
    dirtyRef.current = true;
  }, [motionEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let width = 0;
    let height = 0;
    let frame = 0;
    let lastDraw = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      dirtyRef.current = true;
    };

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const hoveredTarget = hoverRef.current;
      const focus = hoveredTarget ?? (pinnedNodeIdRef.current
        ? { kind: "node" as const, id: pinnedNodeIdRef.current, x: 0, y: 0 }
        : null);
      const pulseMode: PulseMode = hoveredTarget?.kind === "node"
        ? "hover"
        : pinnedNodeIdRef.current
          ? "pinned"
          : "ambient";
      const simulating = motionEnabledRef.current && !reducedMotion && !dragRef.current;
      if (simulating) {
        animateSpatialScene(scene, now);
        dirtyRef.current = true;
      }
      if (!dirtyRef.current || now - lastDraw < 24) return;
      lastDraw = now;
      dirtyRef.current = false;
      drawScene(canvas, width, height, scene, cameraRef.current, focus, now, pulseMode, ambientPulseRef.current, projectedNodesRef, projectedLinksRef);
    };

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      const bounds = container.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      setContainerSize((current) => current.width === nextWidth && current.height === nextHeight
        ? current
        : { width: nextWidth, height: nextHeight });
    });
    observer.observe(container);
    frame = requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scene]);

  const updateHover = (target: HoverTarget | null) => {
    const current = hoverRef.current;
    if (current?.kind === target?.kind && current?.id === target?.id && current?.x === target?.x && current?.y === target?.y) return;
    hoverRef.current = target;
    setHover(target);
    dirtyRef.current = true;
  };

  const updatePinnedNode = (nodeId: string | null) => {
    pinnedNodeIdRef.current = nodeId;
    setPinnedNodeId(nodeId);
    dirtyRef.current = true;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const camera = cameraRef.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = hitTest(event.clientX - bounds.left, event.clientY - bounds.top, projectedNodesRef.current, projectedLinksRef.current);
    const node = target?.kind === "node" ? scene.nodes.find((item) => item.id === target.id) : undefined;
    dragRef.current = {
      pointerId: event.pointerId,
      mode: event.shiftKey ? "pan" : node ? "node" : "orbit",
      startX: event.clientX,
      startY: event.clientY,
      yaw: camera.yaw,
      pitch: camera.pitch,
      panX: camera.panX,
      panY: camera.panY,
      nodeId: node?.id,
      nodeX: node?.x,
      nodeY: node?.y,
      nodeZ: node?.z,
      moved: false,
    };
    dirtyRef.current = true;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.mode === "node" && drag.nodeId) {
        const node = scene.nodes.find((item) => item.id === drag.nodeId);
        if (node) {
          const camera = cameraRef.current;
          const worldDx = dx / Math.max(camera.zoom, 0.1);
          const worldDy = dy / Math.max(camera.zoom, 0.1);
          const cosYaw = Math.cos(camera.yaw);
          const sinYaw = Math.sin(camera.yaw);
          const cosPitch = Math.cos(camera.pitch);
          const sinPitch = Math.sin(camera.pitch);
          node.x = (drag.nodeX ?? node.x) + worldDx * cosYaw - worldDy * sinYaw * sinPitch;
          node.y = (drag.nodeY ?? node.y) + worldDy * cosPitch;
          node.z = (drag.nodeZ ?? node.z) - worldDx * sinYaw - worldDy * cosYaw * sinPitch;
          node.anchorX = node.x;
          node.anchorY = node.y;
          node.anchorZ = node.z;
        }
      } else if (drag.mode === "orbit") {
        cameraRef.current.yaw = drag.yaw + dx * 0.006;
        cameraRef.current.pitch = clamp(drag.pitch + dy * 0.005, -1.08, 1.08);
      } else {
        cameraRef.current.panX = drag.panX + dx;
        cameraRef.current.panY = drag.panY + dy;
      }
      dirtyRef.current = true;
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const target = hitTest(x, y, projectedNodesRef.current, projectedLinksRef.current);
    updateHover(target ? { ...target, x, y } : null);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const target = hitTest(event.clientX - bounds.left, event.clientY - bounds.top, projectedNodesRef.current, projectedLinksRef.current);
      if (target?.kind === "node") {
        updatePinnedNode(pinnedNodeIdRef.current === target.id ? null : target.id);
      } else {
        updatePinnedNode(null);
      }
    }
    dirtyRef.current = true;
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dirtyRef.current = true;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    cameraRef.current.zoom = clamp(
      cameraRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    dirtyRef.current = true;
  };

  const changeZoom = (factor: number) => {
    cameraRef.current.zoom = clamp(cameraRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    dirtyRef.current = true;
  };

  const resetView = () => {
    cameraRef.current = defaultCamera();
    dirtyRef.current = true;
  };

  const focusedNodeId = hover?.kind === "node" ? hover.id : pinnedNodeId;
  const focusedNode = focusedNodeId ? scene.nodes.find((node) => node.id === focusedNodeId) : null;
  const hoveredLink = hover?.kind === "relation" ? scene.links.find((link) => link.relation.id === hover.id) : null;

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[420px] overflow-hidden bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--color-highlight)_8%,transparent),transparent_58%)]"
      style={activeColor ? { background: `radial-gradient(circle at center, color-mix(in srgb, ${activeColor} 10%, transparent), transparent 58%)` } : undefined}
      data-memory-node-radii={scene.nodes.map((node) => `${node.entity.score}:${node.radius.toFixed(2)}`).join(",")}
      data-memory-relation-widths={scene.links.map((link) => `${link.relation.score}:${link.width.toFixed(2)}`).join(",")}
    >
      {summary && (
        <p className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/90 px-3 py-2 text-xs text-[var(--color-text-muted)] shadow-sm backdrop-blur-sm">
          {summary}
        </p>
      )}
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab select-none active:cursor-grabbing"
        role="img"
        aria-label="Interactive three-dimensional Memory relation map"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => { if (!dragRef.current) updateHover(null); }}
        onWheel={handleWheel}
        onDoubleClick={resetView}
      />

      {focusedNode && (
        <MemoryDocumentPreview
          entity={focusedNode.entity}
          color={focusedNode.color}
          containerWidth={containerSize.width}
          pinned={pinnedNodeId === focusedNode.id}
          onRead={() => onOpen(focusedNode.id)}
        />
      )}

      {hoveredLink && hover && (
        <div
          className="pointer-events-none absolute z-20 max-w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-3 py-2.5 shadow-lg backdrop-blur-md"
          style={{ left: Math.min(hover.x + 14, Math.max(12, containerSize.width - 270)), top: Math.max(12, hover.y - 18) }}
        >
          <p className="text-xs font-medium text-[var(--color-text)]">{humanize(hoveredLink.relation.relation_type)}</p>
          <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Relation score {hoveredLink.relation.score}</p>
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-10 inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/92 p-1 shadow-sm backdrop-blur-sm">
        <button type="button" onClick={() => changeZoom(1.15)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Zoom in" aria-label="Zoom in"><Plus className="h-4 w-4" /></button>
        <button type="button" onClick={() => changeZoom(1 / 1.15)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Zoom out" aria-label="Zoom out"><Minus className="h-4 w-4" /></button>
        <span className="mx-0.5 h-5 w-px bg-[var(--color-border)]" />
        <button type="button" onClick={() => setMotionEnabled((current) => !current)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title={motionEnabled ? "Pause node motion" : "Resume node motion"} aria-label={motionEnabled ? "Pause node motion" : "Resume node motion"}>{motionEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button type="button" onClick={resetView} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Reset view" aria-label="Reset graph view"><Maximize2 className="h-4 w-4" /></button>
      </div>
      <p className="pointer-events-none absolute bottom-5 right-5 text-[10px] text-[var(--color-text-muted)]/75">Hover to explore · Click a node to pin · Drag background to orbit</p>
    </div>
  );
}

function MemoryDocumentPreview({
  entity,
  color,
  containerWidth,
  pinned,
  onRead,
}: {
  entity: MemoryEntity;
  color: string;
  containerWidth: number;
  pinned: boolean;
  onRead: () => void;
}) {
  const width = Math.min(300, containerWidth - 28);
  return (
    <article
      className={`${pinned ? "pointer-events-auto" : "pointer-events-none"} absolute left-4 top-16 z-20 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]/97 shadow-[0_18px_45px_rgba(0,0,0,0.16)] backdrop-blur-xl`}
      style={{ width }}
      aria-label={`Preview ${entity.title}`}
    >
      <div className="h-1" style={{ background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 45%, transparent), transparent)` }} />
      <div className="px-5 pb-4 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Memory document</p>
            <h3 className="mt-1.5 text-lg font-semibold leading-snug tracking-tight text-[var(--color-text)]">{entity.title}</h3>
          </div>
          <span className="mt-0.5 rounded-full px-2 py-1 text-[10px] font-medium tabular-nums" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}>{entity.score}</span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">{entity.description}</p>
        {entity.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {entity.tags.slice(0, 4).map((tag) => (
              <span key={`${tag.key}:${tag.value}`} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                {tag.icon ? `${tag.icon} ` : ""}{humanize(tag.key)} · {tag.value}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-5 py-2.5 text-[10px] text-[var(--color-text-muted)]">
        <span>Updated {relativePreviewDate(entity.updated_at)}</span>
        {pinned ? (
          <button type="button" onClick={onRead} className="rounded-md bg-[var(--color-highlight)] px-2.5 py-1.5 font-medium text-white transition-opacity hover:opacity-90">
            Read memory
          </button>
        ) : (
          <span>Click node to pin</span>
        )}
      </div>
    </article>
  );
}

function buildSpatialScene(
  entities: MemoryEntity[],
  relations: MemoryRelation[],
  categoryColors: ReadonlyMap<string, string>,
  activeCategory?: string | null,
  viewport = { width: 720, height: 480 },
): SpatialScene {
  const nodeScores = entities.map((entity) => entity.score);
  const nodeMin = nodeScores.length > 0 ? Math.min(...nodeScores) : 0;
  const nodeMax = nodeScores.length > 0 ? Math.max(...nodeScores) : 100;
  const count = Math.max(entities.length, 1);
  const density = count <= 8 ? 0.82 : count <= 30 ? 1 : 1.12;
  const spatialRadius = clamp(Math.min(viewport.width, viewport.height) * 0.46 * density, 240, 560);
  const bounds = {
    x: spatialRadius,
    y: spatialRadius,
    z: spatialRadius,
  };
  const spaceRadius = Math.max(bounds.x, bounds.y, bounds.z);
  const nodes = entities.map((entity): SpatialNode => {
    // A stable random star inside the volume. Square-root radial sampling keeps
    // the center populated instead of concentrating most points near a shell.
    const radialSeed = stableRandom(entity.entity_id, 1);
    const azimuth = stableRandom(entity.entity_id, 2) * Math.PI * 2;
    const vertical = stableRandom(entity.entity_id, 3) * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    const distance = 0.06 + 0.88 * Math.sqrt(radialSeed);
    const x = Math.cos(azimuth) * ring * distance * bounds.x;
    const y = vertical * distance * bounds.y;
    const z = Math.sin(azimuth) * ring * distance * bounds.z;
    return {
      id: entity.entity_id,
      entity,
      color: categoryColors.get(activeCategory ?? primaryCategory(entity)) ?? COLORS[0],
      radius: nodeRadius(entity.score, nodeMin, nodeMax, count),
      x,
      y,
      z,
      anchorX: x,
      anchorY: y,
      anchorZ: z,
      phase: stableRandom(entity.entity_id, 4) * Math.PI * 2,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visibleRelations = selectVisibleRelations(relations, byId, 3);
  const relationScores = visibleRelations.map((relation) => relation.score);
  const relationMin = relationScores.length > 0 ? Math.min(...relationScores) : 0;
  const relationMax = relationScores.length > 0 ? Math.max(...relationScores) : 100;
  const links = visibleRelations.flatMap((relation): SpatialLink[] => {
    const source = byId.get(relation.source_entity_id);
    const target = byId.get(relation.target_entity_id);
    if (!source || !target) return [];
    const salience = scoreSalience(relation.score, relationMin, relationMax);
    return [{
      relation,
      source,
      target,
      width: 0.4 + salience * 1.15,
      opacity: 0.14 + salience * 0.28,
    }];
  });
  const scene = { nodes, links, bounds, spaceRadius };
  return scene;
}

function drawScene(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  scene: SpatialScene,
  camera: Camera,
  hover: HoverTarget | null,
  now: number,
  pulseMode: PulseMode,
  ambientPulse: AmbientPulseRuntime,
  projectedNodesRef: { current: ProjectedNode[] },
  projectedLinksRef: { current: ProjectedLink[] },
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixelRatio = canvas.width / Math.max(width, 1);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const styles = getComputedStyle(canvas);
  const border = styles.getPropertyValue("--color-border").trim() || "#d8d8d8";
  const surface = styles.getPropertyValue("--color-bg").trim() || "#ffffff";
  const text = styles.getPropertyValue("--color-text").trim() || "#202020";
  const textMuted = styles.getPropertyValue("--color-text-muted").trim() || "#7b7b7b";
  const highlight = styles.getPropertyValue("--color-highlight").trim() || "#0d9f72";
  drawSpatialBackdrop(context, width, height, border);

  const projectedNodes = scene.nodes
    .map((node) => projectNode(node, width, height, camera))
    .sort((left, right) => left.z - right.z);
  const projectedById = new Map(projectedNodes.map((node) => [node.node.id, node]));
  const projectedLinks = scene.links.flatMap((link): ProjectedLink[] => {
    const source = projectedById.get(link.source.id);
    const target = projectedById.get(link.target.id);
    if (!source || !target) return [];
    return [{
      link,
      source,
      target,
      depth: (source.z + target.z) / 2,
      width: link.width * (0.88 + ((source.scale + target.scale) / 2) * 0.12) * Math.sqrt(camera.zoom),
    }];
  }).sort((left, right) => left.depth - right.depth);
  projectedNodesRef.current = projectedNodes;
  const focusedNodeId = hover?.kind === "node" ? hover.id : null;
  const focusedRelationId = hover?.kind === "relation" ? hover.id : null;
  const suppressDefaultLinks = scene.links.length > DEFAULT_LINK_VISIBILITY_LIMIT;
  const labelTopology = focusedNodeId
    ? selectMemoryGraphTopology(
      scene.links.map((link) => link.relation),
      focusedNodeId,
      TOPOLOGY_MAX_DEPTH,
      TOPOLOGY_MAX_NODES,
    )
    : null;
  const focusedTopology = suppressDefaultLinks ? labelTopology : null;
  const displayedLinks = suppressDefaultLinks
    ? projectedLinks.filter(({ link }) => focusedTopology?.relationIds.has(link.relation.id))
    : projectedLinks;
  // Hidden links must not remain hoverable through an invisible hit target.
  projectedLinksRef.current = suppressDefaultLinks ? [] : projectedLinks;
  canvas.dataset.memoryCamera = JSON.stringify(camera);
  canvas.dataset.memoryProjectedNodes = JSON.stringify(projectedNodes.map((node) => ({ id: node.node.id, x: Math.round(node.x), y: Math.round(node.y), radius: Number(node.radius.toFixed(2)) })));
  canvas.dataset.memoryProjectedRelations = JSON.stringify(displayedLinks.map((link) => ({ id: link.link.relation.id, x1: Math.round(link.source.x), y1: Math.round(link.source.y), x2: Math.round(link.target.x), y2: Math.round(link.target.y), width: Number(link.width.toFixed(2)) })));

  const focusedNodeColor = focusedNodeId ? scene.nodes.find((node) => node.id === focusedNodeId)?.color : undefined;
  for (const projected of displayedLinks) {
    const { link, source, target } = projected;
    const relatedToNode = focusedNodeId === source.node.id || focusedNodeId === target.node.id;
    const isFocused = focusedRelationId === link.relation.id || relatedToNode;
    const hasFocus = Boolean(focusedNodeId || focusedRelationId);
    const topologyMode = Boolean(focusedTopology);
    context.beginPath();
    const control = linkCurveControl(projected);
    context.moveTo(source.x, source.y);
    context.quadraticCurveTo(control.x, control.y, target.x, target.y);
    context.lineCap = "round";
    context.lineWidth = topologyMode
      ? clamp(projected.width * 0.82, 0.65, 1.2)
      : projected.width + (isFocused ? 0.8 : 0);
    context.strokeStyle = topologyMode ? (focusedNodeColor ?? highlight) : isFocused ? (focusedNodeColor ?? highlight) : textMuted;
    context.globalAlpha = topologyMode
      ? 0.68 * depthOpacity(projected.depth, scene.spaceRadius)
      : hasFocus ? (isFocused ? 0.92 : 0.09) : link.opacity * depthOpacity(projected.depth, scene.spaceRadius);
    context.stroke();
  }

  const pulseLinks = focusedNodeId && labelTopology
    ? projectedLinks.filter(({ link }) => labelTopology.relationIds.has(link.relation.id))
    : displayedLinks;
  drawNeuralPulses(context, pulseLinks, focusedNodeId, focusedNodeColor ?? highlight, now, pulseMode, ambientPulse);

  const connectedIds = new Set(focusedTopology?.nodeIds ?? []);
  if (focusedNodeId && !focusedTopology) {
    connectedIds.add(focusedNodeId);
    for (const link of scene.links) {
      if (link.source.id === focusedNodeId) connectedIds.add(link.target.id);
      if (link.target.id === focusedNodeId) connectedIds.add(link.source.id);
    }
  }
  if (focusedRelationId) {
    const link = scene.links.find((item) => item.relation.id === focusedRelationId);
    if (link) { connectedIds.add(link.source.id); connectedIds.add(link.target.id); }
  }

  for (const projected of projectedNodes) {
    const { node } = projected;
    const focused = focusedNodeId === node.id;
    const dimmed = connectedIds.size > 0 && !connectedIds.has(node.id);
    const opacity = dimmed ? 0.16 : depthOpacity(projected.z, scene.spaceRadius);
    context.globalAlpha = opacity * (focused ? 0.22 : 0.08);
    context.fillStyle = node.color;
    context.beginPath();
    context.arc(projected.x, projected.y, projected.radius + (focused ? 4 : 2), 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = opacity;
    context.fillStyle = node.color;
    context.beginPath();
    context.arc(projected.x, projected.y, projected.radius, 0, Math.PI * 2);
    context.fill();
    if (focused) {
      const breathing = (Math.sin(now * (pulseMode === "pinned" ? 0.0022 : 0.0034)) + 1) / 2;
      context.globalAlpha = 0.08 + breathing * 0.13;
      context.strokeStyle = node.color;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(projected.x, projected.y, projected.radius + 6 + breathing * 3, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 0.92;
      context.strokeStyle = node.color;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(projected.x, projected.y, projected.radius + 3, 0, Math.PI * 2);
      context.stroke();
    }
  }
  if (labelTopology) {
    const preferredNodeIds = [...labelTopology.nodeIds].slice(0, Math.min(labelTopology.nodeIds.size, TOPOLOGY_LABEL_LIMIT));
    const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    context.font = "500 11px Assistant, system-ui, sans-serif";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    for (const nodeId of preferredNodeIds) {
      const projected = projectedById.get(nodeId);
      if (!projected) continue;
      const title = projected.node.entity.title;
      const label = title.length > 22 ? `${title.slice(0, 21)}…` : title;
      const labelWidth = context.measureText(label).width;
      const candidates = [
        projected.x + projected.radius + 7,
        projected.x - projected.radius - labelWidth - 7,
      ];
      let labelX: number | null = null;
      const labelY = clamp(projected.y, 12, height - 12);
      for (const candidateX of candidates) {
        const rectangle = {
          left: candidateX - 2,
          top: labelY - 8,
          right: candidateX + labelWidth + 2,
          bottom: labelY + 8,
        };
        const inside = rectangle.left >= 8 && rectangle.right <= width - 8;
        const overlaps = occupied.some((item) => rectangle.left < item.right
          && rectangle.right > item.left
          && rectangle.top < item.bottom
          && rectangle.bottom > item.top);
        if (!inside || overlaps) continue;
        occupied.push(rectangle);
        labelX = candidateX;
        break;
      }
      if (labelX === null) continue;
      context.globalAlpha = nodeId === focusedNodeId ? 0.96 : 0.76;
      context.strokeStyle = surface;
      context.lineWidth = 4;
      context.strokeText(label, labelX, labelY);
      context.fillStyle = text;
      context.fillText(label, labelX, labelY);
    }
  }
  context.globalAlpha = 1;
}

function drawNeuralPulses(
  context: CanvasRenderingContext2D,
  links: ProjectedLink[],
  focusedNodeId: string | null,
  color: string,
  now: number,
  mode: PulseMode,
  ambientPulse: AmbientPulseRuntime,
) {
  if (links.length === 0) return;
  context.save();
  context.lineCap = "round";
  context.shadowColor = color;
  context.shadowBlur = 6;

  if (!focusedNodeId) {
    updateAmbientPulseRuntime(ambientPulse, links, now);
    const projectedByRelationId = new Map(links.map((link) => [link.link.relation.id, link]));
    for (const path of ambientPulse.paths) {
      const elapsed = now - path.startedAt;
      const hopIndex = Math.floor(elapsed / path.hopDuration);
      if (hopIndex < 0 || hopIndex >= path.hops.length) continue;
      const hop = path.hops[hopIndex];
      const link = projectedByRelationId.get(hop.relationId);
      if (!link) continue;
      const progress = (elapsed - hopIndex * path.hopDuration) / path.hopDuration;
      const intensity = path.intensity * Math.pow(0.72, hopIndex);
      drawTravelingPulse(context, link, progress, color, intensity, hop.reverse);
    }
    context.restore();
    return;
  }

  const depths = graphHopDepths(links, focusedNodeId);
  const period = mode === "pinned" ? 7_200 : 2_650;
  const wave = ((now % period) / period) * (TOPOLOGY_MAX_DEPTH + 1.35);
  const branchesAtDepth = new Map<number, number>();
  for (const link of links) {
    const sourceDepth = depths.get(link.source.node.id);
    const targetDepth = depths.get(link.target.node.id);
    if (sourceDepth === undefined || targetDepth === undefined) continue;
    const edgeDepth = Math.min(sourceDepth, targetDepth);
    const progress = wave - edgeDepth;
    if (progress < 0 || progress > 1) continue;
    const forward = sourceDepth <= targetDepth;
    const branchIndex = branchesAtDepth.get(edgeDepth) ?? 0;
    branchesAtDepth.set(edgeDepth, branchIndex + 1);
    const baseIntensity = mode === "pinned" ? 0.58 : 0.72;
    const intensity = baseIntensity * Math.pow(0.78, edgeDepth) * Math.pow(0.84, branchIndex);
    drawTravelingPulse(context, link, progress, color, intensity, !forward);
  }
  context.restore();
}

function updateAmbientPulseRuntime(runtime: AmbientPulseRuntime, links: ProjectedLink[], now: number) {
  runtime.paths = runtime.paths.filter((path) => now < path.startedAt + path.hopDuration * path.hops.length);
  if (now < runtime.nextRoundAt) return;

  // Runtime entropy deliberately replaces a fixed pulse count. Every graph node
  // independently decides whether to fire, so a round can contain any number of paths.
  const adjacency = new Map<string, Array<{ link: ProjectedLink; nextNodeId: string; reverse: boolean }>>();
  for (const link of links) {
    const sourceId = link.source.node.id;
    const targetId = link.target.node.id;
    if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
    if (!adjacency.has(targetId)) adjacency.set(targetId, []);
    adjacency.get(sourceId)?.push({ link, nextNodeId: targetId, reverse: false });
    adjacency.get(targetId)?.push({ link, nextNodeId: sourceId, reverse: true });
  }

  for (const startNodeId of adjacency.keys()) {
    if (Math.random() >= 0.075) continue;
    const hops: AmbientPulsePath["hops"] = [];
    const usedRelations = new Set<string>();
    let nodeId = startNodeId;
    const desiredHops = 2 + Math.floor(Math.random() * 4);
    for (let hopIndex = 0; hopIndex < desiredHops; hopIndex += 1) {
      const candidates = (adjacency.get(nodeId) ?? []).filter(({ link }) => !usedRelations.has(link.link.relation.id));
      if (candidates.length === 0) break;
      const candidate = candidates[Math.floor(Math.random() * candidates.length)];
      usedRelations.add(candidate.link.link.relation.id);
      hops.push({ relationId: candidate.link.link.relation.id, reverse: candidate.reverse });
      nodeId = candidate.nextNodeId;
    }
    if (hops.length === 0) continue;
    runtime.paths.push({
      startedAt: now + Math.random() * 320,
      hopDuration: 720 + Math.random() * 520,
      intensity: 0.38 + Math.random() * 0.22,
      hops,
    });
  }

  // Exponential-like jitter produces many short gaps and occasional long pauses
  // without settling into a repeating cadence.
  const interval = Math.min(7_500, 650 + -Math.log(Math.max(0.001, Math.random())) * 1_850);
  runtime.nextRoundAt = now + interval;
}

function drawTravelingPulse(
  context: CanvasRenderingContext2D,
  link: ProjectedLink,
  progress: number,
  color: string,
  intensity: number,
  reverse = false,
) {
  const normalized = clamp(progress, 0, 1);
  const traveled = 0.5 - Math.cos(normalized * Math.PI) / 2;
  const head = reverse ? 1 - traveled : traveled;
  const direction = reverse ? 1 : -1;
  const trailLength = 0.22;
  const segmentCount = 12;
  const entrance = clamp(normalized / 0.1, 0, 1);
  const exit = clamp((1 - normalized) / 0.1, 0, 1);
  const lifecycleOpacity = Math.min(entrance, exit);

  // Draw a soft halo first, then a narrow core. Segment-by-segment falloff
  // creates an asymmetric comet tail instead of a bilateral gradient bar.
  for (const halo of [true, false]) {
    for (let index = segmentCount - 1; index >= 0; index -= 1) {
      const nearHead = 1 - index / segmentCount;
      const start = clamp(head + direction * trailLength * ((index + 1) / segmentCount), 0, 1);
      const end = clamp(head + direction * trailLength * (index / segmentCount), 0, 1);
      if (Math.abs(end - start) < 0.0001) continue;
      const falloff = Math.pow(nearHead, 2.4);
      context.globalAlpha = intensity * lifecycleOpacity * falloff * (halo ? 0.16 : 0.82);
      context.strokeStyle = color;
      context.lineWidth = halo
        ? clamp(link.width + 2.4 * nearHead, 1.8, 3.5)
        : clamp(0.45 + link.width * 0.55 + 0.55 * nearHead, 0.65, 1.35);
      context.beginPath();
      const startPoint = linkCurvePoint(link, start);
      const endPoint = linkCurvePoint(link, end);
      context.moveTo(startPoint.x, startPoint.y);
      context.lineTo(endPoint.x, endPoint.y);
      context.stroke();
    }
  }
}

function graphHopDepths(links: ProjectedLink[], focusedNodeId: string) {
  const adjacency = new Map<string, Set<string>>();
  for (const link of links) {
    const sourceId = link.source.node.id;
    const targetId = link.target.node.id;
    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  }
  const depths = new Map([[focusedNodeId, 0]]);
  const queue = [focusedNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    const depth = depths.get(nodeId) ?? 0;
    for (const neighborId of adjacency.get(nodeId) ?? []) {
      if (depths.has(neighborId)) continue;
      depths.set(neighborId, depth + 1);
      queue.push(neighborId);
    }
  }
  return depths;
}

function drawSpatialBackdrop(context: CanvasRenderingContext2D, width: number, height: number, color: string) {
  context.save();
  context.fillStyle = color;
  for (let index = 0; index < 72; index += 1) {
    const x = stableRandom(`backdrop-${index}`, 1) * width;
    const y = stableRandom(`backdrop-${index}`, 2) * height;
    const radius = 0.45 + stableRandom(`backdrop-${index}`, 3) * 0.75;
    context.globalAlpha = 0.08 + stableRandom(`backdrop-${index}`, 4) * 0.1;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function animateSpatialScene(scene: SpatialScene, now: number) {
  const time = now * 0.00042;
  for (const node of scene.nodes) {
    const amplitude = 10 + stableRandom(node.id, 8) * 8;
    node.x = node.anchorX + Math.sin(time * (0.82 + stableRandom(node.id, 9) * 0.28) + node.phase) * amplitude;
    node.y = node.anchorY + Math.cos(time * (0.76 + stableRandom(node.id, 10) * 0.3) + node.phase * 1.37) * amplitude * 0.82;
    node.z = node.anchorZ + Math.sin(time * (0.7 + stableRandom(node.id, 11) * 0.32) + node.phase * 2.11) * amplitude;
  }
}

function projectNode(node: SpatialNode, width: number, height: number, camera: Camera): ProjectedNode {
  const point = projectPoint(node.x, node.y, node.z, width, height, camera);
  return { node, ...point, radius: node.radius * (0.82 + point.scale * 0.18) * Math.sqrt(camera.zoom) };
}

function projectPoint(x: number, y: number, z: number, width: number, height: number, camera: Camera) {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const xYaw = x * cosYaw - z * sinYaw;
  const zYaw = x * sinYaw + z * cosYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const yPitch = y * cosPitch - zYaw * sinPitch;
  const zPitch = y * sinPitch + zYaw * cosPitch;
  const focalLength = 760;
  const perspective = clamp(focalLength / (focalLength - zPitch), 0.58, 1.55);
  return {
    x: width / 2 + camera.panX + xYaw * perspective * camera.zoom,
    y: height / 2 + camera.panY + yPitch * perspective * camera.zoom,
    z: zPitch,
    scale: perspective,
  };
}

// Bend toward the top of the screen regardless of the relation's source and
// target order. The projected endpoints continue to follow the orbiting scene.
function linkCurveControl(link: ProjectedLink) {
  const dx = link.target.x - link.source.x;
  const dy = link.target.y - link.source.y;
  const length = Math.hypot(dx, dy);
  const offset = Math.min(length * 0.06, 20);
  return {
    x: (link.source.x + link.target.x) / 2,
    y: (link.source.y + link.target.y) / 2 - offset,
  };
}

function linkCurvePoint(link: ProjectedLink, t: number) {
  const control = linkCurveControl(link);
  const inverse = 1 - t;
  return {
    x: inverse * inverse * link.source.x + 2 * inverse * t * control.x + t * t * link.target.x,
    y: inverse * inverse * link.source.y + 2 * inverse * t * control.y + t * t * link.target.y,
  };
}

function distanceToLink(x: number, y: number, link: ProjectedLink) {
  let previous = linkCurvePoint(link, 0);
  let distance = Infinity;
  for (let step = 1; step <= 16; step += 1) {
    const point = linkCurvePoint(link, step / 16);
    distance = Math.min(distance, distanceToSegment(x, y, previous.x, previous.y, point.x, point.y));
    previous = point;
  }
  return distance;
}

function hitTest(x: number, y: number, nodes: ProjectedNode[], links: ProjectedLink[]) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (Math.hypot(x - node.x, y - node.y) <= node.radius + 7) return { kind: "node" as const, id: node.node.id };
  }
  let nearest: { id: string; distance: number } | null = null;
  for (const link of links) {
    const distance = distanceToLink(x, y, link);
    const threshold = Math.max(6, link.width + 3);
    if (distance <= threshold && (!nearest || distance < nearest.distance)) nearest = { id: link.link.relation.id, distance };
  }
  return nearest ? { kind: "relation" as const, id: nearest.id } : null;
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function nodeRadius(score: number, minimum: number, maximum: number, count: number) {
  const salience = scoreSalience(score, minimum, maximum);
  const [small, large] = count <= 12 ? [2.5, 5.5] : count <= 40 ? [2.2, 4.8] : [1.8, 4];
  return small + (large - small) * salience;
}

function scoreSalience(score: number, minimum: number, maximum: number) {
  const absolute = clamp(score / 100, 0, 1);
  if (maximum - minimum < 0.5) return absolute;
  const relative = clamp((score - minimum) / (maximum - minimum), 0, 1);
  return relative * 0.85 + absolute * 0.15;
}

function depthOpacity(depth: number, radius: number) {
  return clamp(0.52 + ((depth + radius) / Math.max(radius * 2, 1)) * 0.48, 0.42, 1);
}

function stableRandom(value: string, salt: number) {
  let hash = 0;
  const input = `${salt}:${value}`;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

function defaultCamera(): Camera {
  return { yaw: -0.42, pitch: -0.16, zoom: 1, panX: 0, panY: 0 };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativePreviewDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function primaryCategory(entity: MemoryEntity) {
  return entity.tags[0]?.key || "Uncategorized";
}
