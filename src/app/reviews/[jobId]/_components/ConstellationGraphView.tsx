"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Application, Container, Graphics } from "pixi.js";
import type {
  ReviewGraphCamera,
  ReviewGraphData,
  ReviewGraphNode,
} from "@/domain/entities/ReviewGraph";
import {
  clampReviewGraphCamera,
  fitReviewGraphCamera,
  getVisibleReviewGraphLabels,
  resolveReviewGraphActiveNodes,
  REVIEW_GRAPH_MAX_ZOOM,
  REVIEW_GRAPH_MIN_ZOOM,
  screenToWorldPoint,
} from "@/lib/reviews/reviewGraphMath";
import {
  buildReviewGraphRenderModel,
  queryReviewGraphSpatialIndex,
  type ReviewGraphRenderEdge,
  updateReviewGraphSpatialIndexNode,
} from "@/lib/reviews/reviewGraphRenderModel";

type PixiModule = typeof import("pixi.js");

interface PixiGraphScene {
  app: Application;
  world: Container;
  canvas: HTMLCanvasElement;
  nodeGraphicsById: Map<string, Graphics>;
  haloGraphicsById: Map<string, Graphics>;
  edgeGraphicsById: Map<string, Graphics>;
}

interface ScreenViewport {
  width: number;
  height: number;
}

interface DragState {
  kind: "pan" | "node";
  startX: number;
  startY: number;
  startCamera: ReviewGraphCamera;
  moved: boolean;
  lastX: number;
  lastY: number;
  lastAt: number;
  nodeId?: string;
  startNodeX?: number;
  startNodeY?: number;
}

interface CameraAnimation {
  from: ReviewGraphCamera;
  to: ReviewGraphCamera;
  startedAt: number;
  durationMs: number;
}

interface PendingFrameWork {
  transform: boolean;
  labels: boolean;
  render: boolean;
  movedNodeIds: Set<string>;
  styledNodeIds: Set<string>;
  styledEdgeIds: Set<string>;
}

export interface ConstellationGraphViewProps {
  reviewGraph: ReviewGraphData;
  currentSceneNumber: number | null;
  selectedNodeId?: string | null;
  onSelectNode: (node: ReviewGraphNode) => void;
  locked?: boolean;
  simulationMode?: "live" | "static";
}

const EDGE_BASE_COLOR = 0xa2afc3;
const EDGE_ACTIVE_COLOR = 0x70dbff;
const NODE_FILL = 0xc9d4e4;
const NODE_STROKE = 0x102033;
const NODE_ACTIVE = 0x78defd;
const NODE_TEST = 0xf8d88f;
const HALO_COLOR = 0x70dbff;
const LABEL_BG = "rgba(8, 12, 18, 0.86)";
const INTERACTION_LABEL_SETTLE_MS = 120;
const GRAPH_CONTROL_CLASS =
  "rounded-full border border-[var(--border-strong)] bg-black/50 px-3 py-1.5 text-xs font-medium text-white transition hover:border-[var(--accent-secondary)] hover:bg-[var(--accent-secondary)]/10 disabled:cursor-not-allowed disabled:opacity-50";

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function interpolateCamera(from: ReviewGraphCamera, to: ReviewGraphCamera, t: number): ReviewGraphCamera {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: from.zoom + (to.zoom - from.zoom) * t,
  };
}

function getNodeRadius(node: ReviewGraphNode): number {
  return 6 + node.importance * 8 + Math.min(4, node.degree * 0.35);
}

function cameraForNode(
  reviewGraph: ReviewGraphData,
  viewport: ScreenViewport,
  node: ReviewGraphNode,
  baseCamera: ReviewGraphCamera,
): ReviewGraphCamera {
  return clampReviewGraphCamera(
    reviewGraph,
    {
      x: node.x,
      y: node.y,
      zoom: Math.max(baseCamera.zoom, 1.12 + node.importance * 0.28),
    },
    viewport,
  );
}

function cameraForNodes(
  reviewGraph: ReviewGraphData,
  viewport: ScreenViewport,
  nodes: readonly ReviewGraphNode[],
  baseCamera: ReviewGraphCamera,
): ReviewGraphCamera {
  if (nodes.length === 0) return baseCamera;
  if (nodes.length === 1) {
    return cameraForNode(reviewGraph, viewport, nodes[0], baseCamera);
  }
  return clampReviewGraphCamera(reviewGraph, fitReviewGraphCamera({ nodes: [...nodes] }, viewport), viewport);
}

function canvasPoint(canvas: HTMLCanvasElement, event: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function labelsKey(labels: ReturnType<typeof getVisibleReviewGraphLabels>): string {
  return labels
    .map((label) => `${label.id}:${label.x}:${label.y}:${label.emphasis}`)
    .join("|");
}

function drawNodeGraphic(graphic: Graphics, node: ReviewGraphNode, isSelected: boolean, isHovered: boolean) {
  const radius = getNodeRadius(node);
  const fillColor = isSelected ? NODE_ACTIVE : node.isTest ? NODE_TEST : NODE_FILL;

  graphic.clear();
  graphic
    .circle(0, 0, radius)
    .fill({ color: fillColor, alpha: isSelected ? 0.98 : 0.92 })
    .stroke({
      width: isSelected ? 2.6 : isHovered ? 2.2 : 1.8,
      color: NODE_STROKE,
      alpha: 0.9,
    });
}

function drawHaloGraphic(graphic: Graphics, node: ReviewGraphNode, isSelected: boolean, isHovered: boolean) {
  graphic.clear();
  if (!isSelected && !isHovered) {
    graphic.visible = false;
    return;
  }

  const radius = getNodeRadius(node) + (isSelected ? 8 : 5);
  graphic.visible = true;
  graphic
    .circle(0, 0, radius)
    .stroke({
      width: isSelected ? 3.6 : 2.4,
      color: HALO_COLOR,
      alpha: isSelected ? 0.76 : 0.28,
    });
}

function drawEdgeGraphic(
  graphic: Graphics,
  edge: ReviewGraphRenderEdge["edge"],
  source: { x: number; y: number },
  target: { x: number; y: number },
  isSelected: boolean,
  isHovered: boolean,
) {
  graphic.clear();
  graphic
    .moveTo(source.x, source.y)
    .lineTo(target.x, target.y)
    .stroke({
      width: isSelected ? 1.8 : 1.15 + edge.strength * 0.35,
      color: isSelected || isHovered ? EDGE_ACTIVE_COLOR : EDGE_BASE_COLOR,
      alpha: isSelected ? 0.28 : isHovered ? 0.2 : 0.09 + edge.strength * 0.08,
      cap: "round",
      join: "round",
    });
}

function StaticStub({
  reviewGraph,
  currentSceneNumber,
  selectedNodeId,
  locked,
}: Pick<ConstellationGraphViewProps, "reviewGraph" | "currentSceneNumber" | "selectedNodeId" | "locked">) {
  return (
    <div
      data-testid="constellation-graph-view"
      aria-disabled={locked}
      style={{ opacity: locked ? 0.4 : 1 }}
    >
      <button type="button" data-testid="graph-control-fit">Fit</button>
      <button type="button" data-testid="graph-control-center-active">Center active</button>
      <button type="button" data-testid="graph-control-reset">Reset</button>
      {reviewGraph.nodes.map((node) => (
        <span
          key={node.id}
          data-testid={`graph-node-${node.id}`}
          data-active={currentSceneNumber !== null && node.sceneNumbers.includes(currentSceneNumber) ? "true" : "false"}
          data-selected={selectedNodeId === node.id ? "true" : "false"}
          data-cluster={node.clusterId}
          data-importance={node.importance.toFixed(2)}
          data-primary-scene={node.primarySceneNumber}
          data-scenes={node.sceneNumbers.join(",")}
          data-x={Math.round(node.x)}
          data-y={Math.round(node.y)}
        />
      ))}
    </div>
  );
}

function createPendingFrameWork(): PendingFrameWork {
  return {
    transform: false,
    labels: false,
    render: false,
    movedNodeIds: new Set<string>(),
    styledNodeIds: new Set<string>(),
    styledEdgeIds: new Set<string>(),
  };
}

export function ConstellationGraphView({
  reviewGraph,
  currentSceneNumber,
  selectedNodeId = null,
  onSelectNode,
  locked = false,
  simulationMode = "live",
}: ConstellationGraphViewProps) {
  const renderModel = useMemo(() => buildReviewGraphRenderModel(reviewGraph), [reviewGraph]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PixiGraphScene | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const inertiaRef = useRef<{ vx: number; vy: number } | null>(null);
  const focusAnimationRef = useRef<CameraAnimation | null>(null);
  const currentSceneNumberRef = useRef<number | null>(currentSceneNumber);
  const cameraRef = useRef<ReviewGraphCamera>(reviewGraph.viewport.initialCamera);
  const hoveredNodeIdRef = useRef<string | null>(null);
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  const labelsKeyRef = useRef("");
  const interactionActiveRef = useRef(false);
  const interactionSettleTimeoutRef = useRef<number | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const pendingFrameRef = useRef<PendingFrameWork>(createPendingFrameWork());
  const [dimensions, setDimensions] = useState<ScreenViewport>({ width: 0, height: 0 });
  const [visibleLabels, setVisibleLabels] = useState<ReturnType<typeof getVisibleReviewGraphLabels>>([]);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [pixiError, setPixiError] = useState(false);
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;

  currentSceneNumberRef.current = currentSceneNumber;

  const canCenterActive = currentSceneNumber !== null
    && resolveReviewGraphActiveNodes(reviewGraph, currentSceneNumber).length > 0;

  const getNodePosition = useCallback((nodeId: string) => {
    const override = nodePositionsRef.current.get(nodeId);
    if (override) {
      return override;
    }
    const node = renderModel.nodesById.get(nodeId);
    return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
  }, [renderModel]);

  const getCurrentNodesSnapshot = useCallback(() => (
    reviewGraph.nodes.map((node) => {
      const override = nodePositionsRef.current.get(node.id);
      return override ? { ...node, x: override.x, y: override.y } : node;
    })
  ), [reviewGraph.nodes]);

  const stopInteractionCooldown = useCallback(() => {
    if (interactionSettleTimeoutRef.current !== null) {
      window.clearTimeout(interactionSettleTimeoutRef.current);
      interactionSettleTimeoutRef.current = null;
    }
  }, []);

  const markInteractionActive = useCallback(() => {
    stopInteractionCooldown();
    if (!interactionActiveRef.current) {
      interactionActiveRef.current = true;
    }
  }, [stopInteractionCooldown]);

  const scheduleInteractionSettle = useCallback((scheduleFrame: () => void) => {
    stopInteractionCooldown();
    interactionSettleTimeoutRef.current = window.setTimeout(() => {
      interactionActiveRef.current = false;
      pendingFrameRef.current.labels = true;
      scheduleFrame();
      interactionSettleTimeoutRef.current = null;
    }, INTERACTION_LABEL_SETTLE_MS);
  }, [stopInteractionCooldown]);

  const syncLabels = useCallback(() => {
    if (dimensionsRef.current.width <= 0 || dimensionsRef.current.height <= 0) {
      return;
    }

    const nextLabels = getVisibleReviewGraphLabels({
      graph: {
        ...reviewGraph,
        nodes: getCurrentNodesSnapshot(),
      },
      camera: cameraRef.current,
      viewport: dimensionsRef.current,
      hoveredNodeId: hoveredNodeIdRef.current ?? undefined,
      activeSceneNumber: currentSceneNumberRef.current ?? undefined,
      selectedNodeId: selectedNodeIdRef.current ?? undefined,
      rankedNodes: renderModel.rankedNodes.map((node) => {
        const override = nodePositionsRef.current.get(node.id);
        return override ? { ...node, x: override.x, y: override.y } : node;
      }),
      contextLabelsEnabled: !interactionActiveRef.current,
    });
    const nextKey = labelsKey(nextLabels);
    if (labelsKeyRef.current !== nextKey) {
      labelsKeyRef.current = nextKey;
      setVisibleLabels(nextLabels);
    }
  }, [getCurrentNodesSnapshot, renderModel.rankedNodes, reviewGraph]);

  const applyCameraTransform = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const viewport = dimensionsRef.current;
    if (viewport.width <= 0 || viewport.height <= 0) return;

    const camera = clampReviewGraphCamera(reviewGraph, cameraRef.current, viewport);
    cameraRef.current = camera;
    scene.world.scale.set(camera.zoom);
    scene.world.position.set(
      viewport.width / 2 - camera.x * camera.zoom,
      viewport.height / 2 - camera.y * camera.zoom,
    );
  }, [reviewGraph]);

  const redrawNodeStyle = useCallback((nodeId: string) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const node = renderModel.nodesById.get(nodeId);
    if (!node) return;

    const isSelected = selectedNodeIdRef.current === nodeId;
    const isHovered = hoveredNodeIdRef.current === nodeId;
    const position = getNodePosition(nodeId);
    const nodeGraphic = scene.nodeGraphicsById.get(nodeId);
    const haloGraphic = scene.haloGraphicsById.get(nodeId);
    if (!nodeGraphic || !haloGraphic) return;

    nodeGraphic.position.set(position.x, position.y);
    haloGraphic.position.set(position.x, position.y);
    drawNodeGraphic(nodeGraphic, node, isSelected, isHovered);
    drawHaloGraphic(haloGraphic, node, isSelected, isHovered);
  }, [getNodePosition, renderModel.nodesById]);

  const redrawEdgeStyle = useCallback((edgeId: string) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const renderEdge = renderModel.edgesById.get(edgeId);
    const edgeGraphic = scene.edgeGraphicsById.get(edgeId);
    if (!renderEdge || !edgeGraphic) return;

    const source = getNodePosition(renderEdge.edge.sourceId);
    const target = getNodePosition(renderEdge.edge.targetId);
    const isSelected = selectedNodeIdRef.current === renderEdge.edge.sourceId
      || selectedNodeIdRef.current === renderEdge.edge.targetId;
    const isHovered = hoveredNodeIdRef.current === renderEdge.edge.sourceId
      || hoveredNodeIdRef.current === renderEdge.edge.targetId;
    drawEdgeGraphic(edgeGraphic, renderEdge.edge, source, target, isSelected, isHovered);
  }, [getNodePosition, renderModel.edgesById]);

  const scheduleFrame = useCallback(() => {
    if (frameRequestRef.current !== null) {
      return;
    }

    frameRequestRef.current = requestAnimationFrame(() => {
      frameRequestRef.current = null;
      const pending = pendingFrameRef.current;
      const scene = sceneRef.current;

      if (pending.transform) {
        applyCameraTransform();
      }

      for (const nodeId of pending.movedNodeIds) {
        const sceneNode = scene?.nodeGraphicsById.get(nodeId);
        const sceneHalo = scene?.haloGraphicsById.get(nodeId);
        const position = getNodePosition(nodeId);
        sceneNode?.position.set(position.x, position.y);
        sceneHalo?.position.set(position.x, position.y);
      }

      for (const nodeId of pending.styledNodeIds) {
        redrawNodeStyle(nodeId);
      }

      for (const edgeId of pending.styledEdgeIds) {
        redrawEdgeStyle(edgeId);
      }

      if (pending.labels) {
        syncLabels();
      }

      if (scene && (pending.transform || pending.movedNodeIds.size > 0 || pending.styledNodeIds.size > 0 || pending.styledEdgeIds.size > 0 || pending.render)) {
        scene.app.render();
      }

      pendingFrameRef.current = createPendingFrameWork();
    });
  }, [applyCameraTransform, getNodePosition, redrawEdgeStyle, redrawNodeStyle, syncLabels]);

  const scheduleNodeStyle = useCallback((nodeIds: Iterable<string>) => {
    const pending = pendingFrameRef.current;
    for (const nodeId of nodeIds) {
      pending.styledNodeIds.add(nodeId);
      const edgeIds = renderModel.incidentEdgesByNodeId.get(nodeId) ?? [];
      for (const edgeId of edgeIds) {
        pending.styledEdgeIds.add(edgeId);
      }
    }
    pending.render = true;
    scheduleFrame();
  }, [renderModel.incidentEdgesByNodeId, scheduleFrame]);

  const scheduleMovedNode = useCallback((nodeId: string) => {
    const pending = pendingFrameRef.current;
    pending.movedNodeIds.add(nodeId);
    const edgeIds = renderModel.incidentEdgesByNodeId.get(nodeId) ?? [];
    for (const edgeId of edgeIds) {
      pending.styledEdgeIds.add(edgeId);
    }
    pending.labels = true;
    pending.render = true;
    scheduleFrame();
  }, [renderModel.incidentEdgesByNodeId, scheduleFrame]);

  const scheduleTransform = useCallback((withLabels = true) => {
    const pending = pendingFrameRef.current;
    pending.transform = true;
    pending.render = true;
    if (withLabels) {
      pending.labels = true;
    }
    scheduleFrame();
  }, [scheduleFrame]);

  const stopAnimationLoop = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const runAnimationLoop = useCallback(() => {
    if (animationFrameRef.current !== null) return;

    const tick = (now: number) => {
      animationFrameRef.current = null;
      let continueAnimating = false;

      if (focusAnimationRef.current) {
        const animation = focusAnimationRef.current;
        const progress = Math.min(1, (now - animation.startedAt) / animation.durationMs);
        cameraRef.current = interpolateCamera(animation.from, animation.to, easeOutCubic(progress));
        if (progress < 1) {
          continueAnimating = true;
        } else {
          focusAnimationRef.current = null;
        }
      } else if (inertiaRef.current) {
        cameraRef.current = clampReviewGraphCamera(
          reviewGraph,
          {
            x: cameraRef.current.x - inertiaRef.current.vx / cameraRef.current.zoom,
            y: cameraRef.current.y - inertiaRef.current.vy / cameraRef.current.zoom,
            zoom: cameraRef.current.zoom,
          },
          dimensionsRef.current,
        );
        inertiaRef.current = {
          vx: inertiaRef.current.vx * 0.88,
          vy: inertiaRef.current.vy * 0.88,
        };
        continueAnimating = Math.abs(inertiaRef.current.vx) > 0.12 || Math.abs(inertiaRef.current.vy) > 0.12;
        if (!continueAnimating) {
          inertiaRef.current = null;
        }
      }

      scheduleTransform(true);

      if (continueAnimating) {
        animationFrameRef.current = requestAnimationFrame(tick);
      }
    };

    animationFrameRef.current = requestAnimationFrame(tick);
  }, [reviewGraph, scheduleTransform]);

  const commitCamera = useCallback((camera: ReviewGraphCamera, animate: boolean) => {
    const clamped = clampReviewGraphCamera(reviewGraph, camera, dimensionsRef.current);
    if (animate) {
      focusAnimationRef.current = {
        from: cameraRef.current,
        to: clamped,
        startedAt: performance.now(),
        durationMs: 260,
      };
      inertiaRef.current = null;
      runAnimationLoop();
      return;
    }

    focusAnimationRef.current = null;
    cameraRef.current = clamped;
    scheduleTransform(true);
  }, [reviewGraph, runAnimationLoop, scheduleTransform]);

  const focusNode = useCallback((node: ReviewGraphNode | null, animate = true) => {
    if (!node) return;
    const nextCamera = cameraForNode(reviewGraph, dimensionsRef.current, {
      ...node,
      ...getNodePosition(node.id),
    }, cameraRef.current);
    commitCamera(nextCamera, animate);
  }, [commitCamera, getNodePosition, reviewGraph]);

  const focusNodes = useCallback((nodes: readonly ReviewGraphNode[], animate = true) => {
    if (nodes.length === 0) return;
    const nextCamera = cameraForNodes(reviewGraph, dimensionsRef.current, nodes.map((node) => ({
      ...node,
      ...getNodePosition(node.id),
    })), cameraRef.current);
    commitCamera(nextCamera, animate);
  }, [commitCamera, getNodePosition, reviewGraph]);

  const pickNodeAtPoint = useCallback((point: { x: number; y: number }) => {
    const world = screenToWorldPoint(point, cameraRef.current, dimensionsRef.current);
    const searchRadius = 10 / cameraRef.current.zoom + 14;
    const candidateIds = queryReviewGraphSpatialIndex(renderModel.spatialIndex, world, searchRadius);
    let closest: ReviewGraphNode | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const nodeId of candidateIds) {
      const node = renderModel.nodesById.get(nodeId);
      if (!node) continue;
      const position = getNodePosition(nodeId);
      const distance = Math.hypot(world.x - position.x, world.y - position.y);
      if (distance > searchRadius) continue;
      if (distance < closestDistance) {
        closest = { ...node, ...position };
        closestDistance = distance;
      }
    }

    return closest;
  }, [getNodePosition, renderModel.nodesById, renderModel.spatialIndex]);

  const readyToMount = dimensions.width > 0 && dimensions.height > 0;

  useEffect(() => {
    const nextPositions = new Map<string, { x: number; y: number }>();
    for (const node of reviewGraph.nodes) {
      nextPositions.set(node.id, { x: node.x, y: node.y });
    }
    nodePositionsRef.current = nextPositions;
    hoveredNodeIdRef.current = null;
    labelsKeyRef.current = "";
    interactionActiveRef.current = false;
  }, [reviewGraph.nodes]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const rect = container.getBoundingClientRect();
      const next = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      setDimensions((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };

    measure();
    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (!next) return;
      setDimensions((current) => {
        const width = Math.round(next.width);
        const height = Math.round(next.height);
        return current.width === width && current.height === height
          ? current
          : { width, height };
      });
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (simulationMode === "static") return;
    if (!canvasHostRef.current || !readyToMount) return;

    let cancelled = false;

    async function mountPixi() {
      try {
        const dims = dimensionsRef.current;
        const PIXI: PixiModule = await import("pixi.js");
        if (cancelled || !canvasHostRef.current) return;

        setPixiError(false);
        const app = new PIXI.Application();
        await app.init({
          width: dims.width,
          height: dims.height,
          autoDensity: true,
          antialias: true,
          autoStart: false,
          backgroundAlpha: 0,
          resolution: 1,
          preference: "webgl",
        });

        if (cancelled || !canvasHostRef.current) {
          app.destroy();
          return;
        }

        const world = new PIXI.Container();
        const edgeContainer = new PIXI.Container();
        const haloContainer = new PIXI.Container();
        const nodeContainer = new PIXI.Container();
        world.addChild(edgeContainer, haloContainer, nodeContainer);
        app.stage.addChild(world);

        const nodeGraphicsById = new Map<string, Graphics>();
        const haloGraphicsById = new Map<string, Graphics>();
        const edgeGraphicsById = new Map<string, Graphics>();

        for (const edgeId of renderModel.edgeIds) {
          const renderEdge = renderModel.edgesById.get(edgeId);
          if (!renderEdge) continue;
          const graphic = new PIXI.Graphics();
          edgeGraphicsById.set(edgeId, graphic);
          edgeContainer.addChild(graphic);
        }

        for (const node of reviewGraph.nodes) {
          const haloGraphic = new PIXI.Graphics();
          const nodeGraphic = new PIXI.Graphics();
          haloGraphicsById.set(node.id, haloGraphic);
          nodeGraphicsById.set(node.id, nodeGraphic);
          haloContainer.addChild(haloGraphic);
          nodeContainer.addChild(nodeGraphic);
        }

        const canvas = app.canvas as HTMLCanvasElement;
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.touchAction = "none";
        canvas.style.display = "block";

        while (canvasHostRef.current.firstChild) {
          canvasHostRef.current.removeChild(canvasHostRef.current.firstChild);
        }
        canvasHostRef.current.appendChild(canvas);
        sceneRef.current = {
          app,
          world,
          canvas,
          nodeGraphicsById,
          haloGraphicsById,
          edgeGraphicsById,
        };
        setCanvasVersion((value) => value + 1);

        cameraRef.current = fitReviewGraphCamera(reviewGraph, dims);
        const pending = pendingFrameRef.current;
        pending.transform = true;
        pending.labels = true;
        pending.render = true;
        for (const node of reviewGraph.nodes) {
          pending.styledNodeIds.add(node.id);
        }
        for (const edgeId of renderModel.edgeIds) {
          pending.styledEdgeIds.add(edgeId);
        }
        scheduleFrame();
      } catch (err) {
        if (cancelled) return;
        console.error("[ConstellationGraphView] Failed to initialize PixiJS renderer", {
          error: err instanceof Error ? err.message : String(err),
        });
        setPixiError(true);
      }
    }

    void mountPixi();

    return () => {
      cancelled = true;
      stopAnimationLoop();
      if (frameRequestRef.current !== null) {
        cancelAnimationFrame(frameRequestRef.current);
        frameRequestRef.current = null;
      }
      stopInteractionCooldown();
      try {
        sceneRef.current?.app.destroy();
      } catch (err) {
        console.error("[ConstellationGraphView] Error during PixiJS teardown", err);
      }
      sceneRef.current = null;
    };
  }, [readyToMount, renderModel, reviewGraph, scheduleFrame, simulationMode, stopAnimationLoop, stopInteractionCooldown]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    try {
      scene.app.renderer.resize(dimensions.width, dimensions.height);
    } catch (err) {
      console.error("[ConstellationGraphView] Resize failed — WebGL context may be lost", err);
      setPixiError(true);
      return;
    }
    scheduleTransform(true);
  }, [dimensions, scheduleTransform]);

  useEffect(() => {
    pendingFrameRef.current.labels = true;
    scheduleFrame();
  }, [currentSceneNumber, scheduleFrame]);

  useEffect(() => {
    const previousSelected = selectedNodeIdRef.current;
    const nextSelected = selectedNodeId;
    selectedNodeIdRef.current = nextSelected;
    const affected = new Set<string>();
    if (previousSelected) affected.add(previousSelected);
    if (nextSelected) affected.add(nextSelected);
    if (affected.size > 0) {
      scheduleNodeStyle(affected);
    }
    pendingFrameRef.current.labels = true;
    scheduleFrame();
  }, [scheduleFrame, scheduleNodeStyle, selectedNodeId]);

  useEffect(() => {
    if (simulationMode === "static" || locked) return;
    const canvas = sceneRef.current?.canvas;
    if (!canvas) return;

    /** Swap the hovered node ref, schedule style redraws for affected nodes, and mark labels dirty. */
    const swapHovered = (nextId: string | null): boolean => {
      const previousId = hoveredNodeIdRef.current;
      if (previousId === nextId) return false;
      hoveredNodeIdRef.current = nextId;
      const affected = [previousId, nextId].filter((id): id is string => id !== null);
      if (affected.length > 0) {
        scheduleNodeStyle(affected);
        pendingFrameRef.current.labels = true;
        scheduleFrame();
      }
      return true;
    };

    const onPointerDown = (event: PointerEvent) => {
      const point = canvasPoint(canvas, event);
      const pickedNode = pickNodeAtPoint(point);
      dragRef.current = {
        kind: pickedNode ? "node" : "pan",
        startX: event.clientX,
        startY: event.clientY,
        startCamera: cameraRef.current,
        moved: false,
        lastX: event.clientX,
        lastY: event.clientY,
        lastAt: performance.now(),
        nodeId: pickedNode?.id,
        startNodeX: pickedNode?.x,
        startNodeY: pickedNode?.y,
      };
      inertiaRef.current = null;
      focusAnimationRef.current = null;
      swapHovered(pickedNode?.id ?? null);
      markInteractionActive();
      canvas.style.cursor = "grabbing";
    };

    const onPointerMove = (event: PointerEvent) => {
      const point = canvasPoint(canvas, event);

      if (!dragRef.current) {
        const hovered = pickNodeAtPoint(point);
        swapHovered(hovered?.id ?? null);
        canvas.style.cursor = hovered ? "pointer" : "grab";
        return;
      }

      markInteractionActive();
      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;
      if (!dragRef.current.moved && Math.hypot(dx, dy) >= 4) {
        dragRef.current.moved = true;
      }

      if (dragRef.current.kind === "node" && dragRef.current.nodeId) {
        const nodeId = dragRef.current.nodeId;
        const previousPosition = getNodePosition(nodeId);
        const nextPosition = {
          x: (dragRef.current.startNodeX ?? 0) + dx / dragRef.current.startCamera.zoom,
          y: (dragRef.current.startNodeY ?? 0) + dy / dragRef.current.startCamera.zoom,
        };
        nodePositionsRef.current.set(nodeId, nextPosition);
        updateReviewGraphSpatialIndexNode(renderModel.spatialIndex, nodeId, previousPosition, nextPosition);
        hoveredNodeIdRef.current = nodeId;
        inertiaRef.current = null;
        scheduleMovedNode(nodeId);
      } else {
        cameraRef.current = clampReviewGraphCamera(
          reviewGraph,
          {
            x: dragRef.current.startCamera.x - dx / dragRef.current.startCamera.zoom,
            y: dragRef.current.startCamera.y - dy / dragRef.current.startCamera.zoom,
            zoom: dragRef.current.startCamera.zoom,
          },
          dimensionsRef.current,
        );

        const now = performance.now();
        const dt = Math.max(16, now - dragRef.current.lastAt);
        inertiaRef.current = {
          vx: (event.clientX - dragRef.current.lastX) / dt * 16,
          vy: (event.clientY - dragRef.current.lastY) / dt * 16,
        };
        dragRef.current.lastX = event.clientX;
        dragRef.current.lastY = event.clientY;
        dragRef.current.lastAt = now;
        scheduleTransform(true);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      canvas.style.cursor = "grab";
      if (!drag) return;

      scheduleInteractionSettle(scheduleFrame);
      const point = canvasPoint(canvas, event);

      if (!drag.moved) {
        const pickedNode = pickNodeAtPoint(point);
        if (pickedNode) {
          swapHovered(pickedNode.id);
          focusNode(pickedNode, true);
          onSelectNode(pickedNode);
          return;
        }
      }

      if (drag.kind === "pan" && drag.moved && inertiaRef.current) {
        runAnimationLoop();
      }
    };

    const onPointerLeave = () => {
      if (dragRef.current) return;
      swapHovered(null);
      scheduleInteractionSettle(scheduleFrame);
      canvas.style.cursor = "grab";
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      markInteractionActive();
      const point = canvasPoint(canvas, event);
      const cursorWorld = screenToWorldPoint(point, cameraRef.current, dimensionsRef.current);
      const nextZoom = Math.min(
        REVIEW_GRAPH_MAX_ZOOM,
        Math.max(
          REVIEW_GRAPH_MIN_ZOOM,
          cameraRef.current.zoom * Math.exp(-event.deltaY * 0.0012),
        ),
      );
      commitCamera(
        {
          x: cursorWorld.x - (point.x - dimensionsRef.current.width / 2) / nextZoom,
          y: cursorWorld.y - (point.y - dimensionsRef.current.height / 2) / nextZoom,
          zoom: nextZoom,
        },
        false,
      );
      scheduleInteractionSettle(scheduleFrame);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [
    canvasVersion,
    commitCamera,
    focusNode,
    getNodePosition,
    locked,
    markInteractionActive,
    onSelectNode,
    pickNodeAtPoint,
    reviewGraph,
    runAnimationLoop,
    scheduleFrame,
    scheduleInteractionSettle,
    scheduleMovedNode,
    scheduleNodeStyle,
    scheduleTransform,
    simulationMode,
  ]);

  const handleFit = useCallback(() => {
    commitCamera(fitReviewGraphCamera(reviewGraph, dimensionsRef.current), true);
  }, [commitCamera, reviewGraph]);

  const handleCenterActive = useCallback(() => {
    const nodes = resolveReviewGraphActiveNodes(reviewGraph, currentSceneNumber).map((node) => ({
      ...node,
      ...getNodePosition(node.id),
    }));
    focusNodes(nodes, true);
  }, [currentSceneNumber, focusNodes, getNodePosition, reviewGraph]);

  const handleReset = useCallback(() => {
    for (const node of reviewGraph.nodes) {
      const previous = getNodePosition(node.id);
      const next = { x: node.x, y: node.y };
      nodePositionsRef.current.set(node.id, next);
      updateReviewGraphSpatialIndexNode(renderModel.spatialIndex, node.id, previous, next);
      scheduleMovedNode(node.id);
    }
    commitCamera(fitReviewGraphCamera(reviewGraph, dimensionsRef.current), true);
  }, [commitCamera, getNodePosition, renderModel.spatialIndex, reviewGraph, scheduleMovedNode]);

  useEffect(() => () => {
    stopInteractionCooldown();
    stopAnimationLoop();
    if (frameRequestRef.current !== null) {
      cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
  }, [stopAnimationLoop, stopInteractionCooldown]);

  if (simulationMode === "static") {
    return (
      <StaticStub
        reviewGraph={reviewGraph}
        currentSceneNumber={currentSceneNumber}
        selectedNodeId={selectedNodeId}
        locked={locked}
      />
    );
  }

  if (pixiError) {
    return (
      <div
        data-testid="constellation-graph-view"
        className="flex h-full w-full items-center justify-center rounded-[28px] border border-[var(--border)] bg-[#0b0f1a] text-sm text-white/60"
      >
        Graph unavailable — your browser may not support WebGL
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="constellation-graph-view"
      aria-disabled={locked}
      className="relative h-full w-full overflow-hidden rounded-[28px] border border-[var(--border)]"
      style={{
        opacity: locked ? 0.4 : 1,
        background:
          "radial-gradient(circle at 20% 18%, rgba(112,219,255,0.08), transparent 34%), linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0) 20%), #0b0f1a",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at center, transparent 58%, rgba(4, 7, 12, 0.72) 100%)",
        }}
      />

      <div className="absolute left-4 top-4 z-10 flex gap-2">
        <button
          type="button"
          data-testid="graph-control-fit"
          onClick={handleFit}
          disabled={locked}
          className={GRAPH_CONTROL_CLASS}
        >
          Fit
        </button>
        <button
          type="button"
          data-testid="graph-control-center-active"
          onClick={handleCenterActive}
          disabled={locked || !canCenterActive}
          className={GRAPH_CONTROL_CLASS}
        >
          Center active
        </button>
        <button
          type="button"
          data-testid="graph-control-reset"
          onClick={handleReset}
          disabled={locked}
          className={GRAPH_CONTROL_CLASS}
        >
          Reset
        </button>
      </div>

      <div
        ref={canvasHostRef}
        className="absolute inset-0"
        style={{ cursor: locked ? "default" : "grab" }}
      />

      <div className="pointer-events-none absolute inset-0 z-10">
        {visibleLabels.map((label) => (
          <div
            key={label.id}
            data-testid={`graph-label-${label.id}`}
            className="absolute -translate-x-1/2 rounded-full border px-2 py-1 text-[11px] font-medium text-white shadow-[0_10px_24px_rgba(0,0,0,0.35)]"
            style={{
              left: label.x,
              top: label.y + 16,
              background: LABEL_BG,
              borderColor:
                label.emphasis === "selected"
                  ? "rgba(112,219,255,0.7)"
                  : label.emphasis === "hovered"
                    ? "rgba(112,219,255,0.48)"
                    : "rgba(255,255,255,0.12)",
              opacity: label.emphasis === "context" ? 0.9 : 1,
            }}
          >
            {label.text}
          </div>
        ))}
      </div>
    </div>
  );
}
