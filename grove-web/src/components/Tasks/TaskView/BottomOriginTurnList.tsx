import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent,
} from "react";
import {
  bottomDistance,
  buildBottomOriginLayout,
  visibleBottomOriginIndexes,
} from "./bottomOriginLayout";

export type BottomOriginTurn = {
  key: string;
  messageIndex: number;
  renderStart: number;
  renderEnd: number;
};

export type BottomOriginTurnListHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToTurn: (
    key: string,
    align?: "start" | "center" | "end",
  ) => void;
  scrollToRenderItem: (renderIndex: number) => void;
};

type Props = {
  scopeKey: string;
  turnsNewestFirst: readonly BottomOriginTurn[];
  initialTurnCount: number;
  loadBatchSize: number;
  estimatedTurnHeight?: number;
  overscan?: number;
  topContent: ReactNode;
  bottomContent: ReactNode;
  renderTurn: (turn: BottomOriginTurn) => ReactNode;
  scrollerRef: (element: HTMLDivElement | null) => void;
  onScroll: () => void;
  onVisibleTurnChange?: (turn: BottomOriginTurn | null) => void;
  onItemsRendered?: () => void;
  onLayoutChange?: () => void;
};

type PendingNavigation = {
  key: string;
  align: "start" | "center" | "end";
  attempts: number;
};

const heightCache = new Map<string, number>();
const MAX_CACHED_TURNS = 2_000;

export const BottomOriginTurnList = forwardRef<
  BottomOriginTurnListHandle,
  Props
>(function BottomOriginTurnList(
  {
    scopeKey,
    turnsNewestFirst,
    initialTurnCount,
    loadBatchSize,
    estimatedTurnHeight = 640,
    overscan = 1_600,
    topContent,
    bottomContent,
    renderTurn,
    scrollerRef,
    onScroll,
    onVisibleTurnChange,
    onItemsRendered,
    onLayoutChange,
  },
  forwardedRef,
) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [oldestLoadedKey, setOldestLoadedKey] = useState(
    () => turnsNewestFirst[Math.min(initialTurnCount, turnsNewestFirst.length) - 1]?.key ?? null,
  );
  const [measurementState, setMeasurementState] = useState<{
    scope: string;
    heights: Map<string, number>;
  }>(() => ({ scope: scopeKey, heights: new Map() }));
  const measuredHeights = useMemo(
    () =>
      measurementState.scope === scopeKey
        ? measurementState.heights
        : new Map<string, number>(),
    [measurementState, scopeKey],
  );
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const pendingAnchorRef = useRef<{ key: string; offset: number } | null>(null);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedKeysRef = useRef(new WeakMap<Element, string>());

  const oldestLoadedIndex = useMemo(() => {
    if (turnsNewestFirst.length === 0) return -1;
    if (oldestLoadedKey === null) {
      return Math.min(initialTurnCount, turnsNewestFirst.length) - 1;
    }
    const index = turnsNewestFirst.findIndex((turn) => turn.key === oldestLoadedKey);
    return index < 0
      ? Math.min(initialTurnCount, turnsNewestFirst.length) - 1
      : index;
  }, [initialTurnCount, oldestLoadedKey, turnsNewestFirst]);
  const loadedTurns = useMemo(
    () => turnsNewestFirst.slice(0, oldestLoadedIndex + 1),
    [oldestLoadedIndex, turnsNewestFirst],
  );
  const layout = useMemo(
    () =>
      buildBottomOriginLayout(
        loadedTurns.map((turn) => ({
          key: turn.key,
          height:
            measuredHeights.get(turn.key) ??
            heightCache.get(`${scopeKey}:${turn.key}`) ??
            estimatedTurnHeight,
        })),
      ),
    [estimatedTurnHeight, loadedTurns, measuredHeights, scopeKey],
  );
  const positionByKey = useMemo(
    () => new Map(layout.positions.map((position) => [position.key, position])),
    [layout.positions],
  );

  const captureAnchor = useCallback(() => {
    const viewportElement = viewportRef.current;
    if (!viewportElement) return;
    if (
      bottomDistance(
        viewportElement.scrollHeight,
        viewportElement.scrollTop,
        viewportElement.clientHeight,
      ) <= 48
    ) {
      pendingAnchorRef.current = null;
      return;
    }
    const viewportTop = viewportElement.getBoundingClientRect().top;
    const viewportBottom = viewportElement.getBoundingClientRect().bottom;
    const visible = Array.from(
      viewportElement.querySelectorAll<HTMLElement>("[data-turn-key]"),
    )
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom >= viewportTop && rect.top <= viewportBottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (!visible?.element.dataset.turnKey) return;
    pendingAnchorRef.current = {
      key: visible.element.dataset.turnKey,
      offset: visible.rect.top - viewportTop,
    };
  }, []);
  const mountedIndexes = useMemo(() => {
    if (viewport.height <= 0) {
      return loadedTurns.length === 0 ? [] : [0];
    }
    return visibleBottomOriginIndexes(
      layout.positions,
      viewport.top,
      viewport.top + viewport.height,
      overscan,
    );
  }, [layout.positions, loadedTurns.length, overscan, viewport]);

  useLayoutEffect(() => {
    if (measurementState.scope === scopeKey) return;
    captureAnchor();
    setMeasurementState({ scope: scopeKey, heights: new Map() });
  }, [captureAnchor, measurementState.scope, scopeKey]);

  const assignScroller = useCallback(
    (element: HTMLDivElement | null) => {
      viewportRef.current = element;
      scrollerRef(element);
      if (element) {
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      }
    },
    [scrollerRef],
  );

  const alignTurn = useCallback(
    (key: string, align: "start" | "center" | "end") => {
      const element = viewportRef.current;
      const position = positionByKey.get(key);
      const canvas = canvasRef.current;
      if (!element || !position || !canvas) return false;
      let top = canvas.offsetTop + position.top;
      if (align === "center") {
        top -= (element.clientHeight - position.height) / 2;
      } else if (align === "end") {
        top -= element.clientHeight - position.height;
      }
      element.scrollTop = Math.max(
        0,
        Math.min(top, element.scrollHeight - element.clientHeight),
      );
      setViewport({ top: element.scrollTop, height: element.clientHeight });
      return true;
    },
    [positionByKey],
  );

  const requestTurnNavigation = useCallback(
    (key: string, align: "start" | "center" | "end" = "start") => {
      const targetIndex = turnsNewestFirst.findIndex((turn) => turn.key === key);
      if (targetIndex < 0) return;
      if (targetIndex > oldestLoadedIndex) {
        setOldestLoadedKey(turnsNewestFirst[targetIndex].key);
      }
      pendingNavigationRef.current = { key, align, attempts: 0 };
      if (targetIndex <= oldestLoadedIndex) alignTurn(key, align);
    },
    [alignTurn, oldestLoadedIndex, turnsNewestFirst],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      scrollToBottom(behavior = "auto") {
        const element = viewportRef.current;
        if (!element) return;
        element.scrollTo({ top: element.scrollHeight, behavior });
      },
      scrollToTurn: requestTurnNavigation,
      scrollToRenderItem(renderIndex) {
        const turn = turnsNewestFirst.find(
          (candidate) =>
            renderIndex >= candidate.renderStart &&
            renderIndex < candidate.renderEnd,
        );
        if (!turn) return;
        requestTurnNavigation(turn.key, "center");
        requestAnimationFrame(() => {
          viewportRef.current
            ?.querySelector<HTMLElement>(`[data-item-index="${renderIndex}"]`)
            ?.scrollIntoView({ block: "center", behavior: "auto" });
        });
      },
    }),
    [requestTurnNavigation, turnsNewestFirst],
  );

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const anchor = pendingAnchorRef.current;
    const anchoredElement = anchor
      ? element.querySelector<HTMLElement>(`[data-turn-key="${anchor.key}"]`)
      : null;
    if (anchor && anchoredElement) {
      element.scrollTop +=
        anchoredElement.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        anchor.offset;
    }
    pendingAnchorRef.current = null;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
  }, [layout.totalHeight]);

  useLayoutEffect(() => {
    const pending = pendingNavigationRef.current;
    if (!pending) return;
    if (!alignTurn(pending.key, pending.align)) return;
    if (pending.attempts >= 2) {
      pendingNavigationRef.current = null;
      return;
    }
    pending.attempts += 1;
    const frame = requestAnimationFrame(() => {
      alignTurn(pending.key, pending.align);
      if (pending.attempts >= 2) pendingNavigationRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [alignTurn, measuredHeights, oldestLoadedIndex]);

  const observeTurn = useCallback(
    (element: HTMLDivElement | null, key: string) => {
      if (!element) return;
      observedKeysRef.current.set(element, key);
      const measure = (target: Element) => {
        const observedKey = observedKeysRef.current.get(target);
        if (!observedKey) return;
        const height = Math.ceil(target.getBoundingClientRect().height);
        if (height <= 0) return;
        const cacheKey = `${scopeKey}:${observedKey}`;
        if (heightCache.get(cacheKey) === height) return;
        captureAnchor();
        heightCache.set(cacheKey, height);
        while (heightCache.size > MAX_CACHED_TURNS) {
          const oldest = heightCache.keys().next().value;
          if (oldest === undefined) break;
          heightCache.delete(oldest);
        }
        setMeasurementState((current) => {
          const currentHeights = current.scope === scopeKey
            ? current.heights
            : new Map<string, number>();
          if (currentHeights.get(observedKey) === height) return current;
          const next = new Map(currentHeights);
          next.set(observedKey, height);
          return { scope: scopeKey, heights: next };
        });
        onLayoutChange?.();
      };
      measure(element);
      if (typeof ResizeObserver === "undefined") return;
      if (!resizeObserverRef.current) {
        resizeObserverRef.current = new ResizeObserver((entries) => {
          for (const entry of entries) measure(entry.target);
        });
      }
      resizeObserverRef.current.observe(element);
    },
    [captureAnchor, onLayoutChange, scopeKey],
  );

  useLayoutEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    },
    [],
  );

  const loadOlderTurns = useCallback(() => {
    if (oldestLoadedIndex >= turnsNewestFirst.length - 1) return;
    captureAnchor();
    const nextIndex = Math.min(
      turnsNewestFirst.length - 1,
      oldestLoadedIndex + loadBatchSize,
    );
    setOldestLoadedKey(turnsNewestFirst[nextIndex].key);
  }, [
    captureAnchor,
    loadBatchSize,
    oldestLoadedIndex,
    turnsNewestFirst,
  ]);

  const handleScroll = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    const distanceFromBottom = bottomDistance(
      element.scrollHeight,
      element.scrollTop,
      element.clientHeight,
    );
    if (element.scrollTop <= 240 && oldestLoadedIndex < turnsNewestFirst.length - 1) {
      loadOlderTurns();
    }
    const viewportMiddle =
      element.scrollTop + element.clientHeight / 2 - (canvasRef.current?.offsetTop ?? 0);
    const active = distanceFromBottom <= 48
      ? loadedTurns[0] ?? null
      : layout.positions.reduce<BottomOriginTurn | null>(
          (current, position) => {
            if (
              current ||
              viewportMiddle < position.top ||
              viewportMiddle > position.bottom
            ) {
              return current;
            }
            return loadedTurns[position.index] ?? null;
          },
          null,
        );
    onVisibleTurnChange?.(active);
    onScroll();
  }, [
    layout.positions,
    loadedTurns,
    loadOlderTurns,
    oldestLoadedIndex,
    onScroll,
    onVisibleTurnChange,
    turnsNewestFirst,
  ]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const element = viewportRef.current;
    if (!element || event.deltaY >= 0 || element.scrollTop > 240) return;
    loadOlderTurns();
  }, [loadOlderTurns]);

  useLayoutEffect(() => {
    onItemsRendered?.();
  }, [mountedIndexes, onItemsRendered]);

  return (
    <div
      ref={assignScroller}
      className="task-chat-virtual-scroller chat-selection-layout relative z-0 h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none"
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      {topContent}
      <div
        ref={canvasRef}
        className="chat-selection-layout relative min-h-full"
        style={{ height: layout.totalHeight }}
      >
        {mountedIndexes.map((index) => {
          const turn = loadedTurns[index];
          const position = layout.positions[index];
          if (!turn || !position) return null;
          return (
            <div
              key={turn.key}
              ref={(element) => observeTurn(element, turn.key)}
              data-turn-key={turn.key}
              className="chat-selection-layout absolute inset-x-0"
              style={{ top: position.top }}
            >
              {renderTurn(turn)}
            </div>
          );
        })}
      </div>
      {bottomContent}
    </div>
  );
});
