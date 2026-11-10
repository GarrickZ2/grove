import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MotionConfig } from "framer-motion";
import { useSettingsState, type SettingsState } from "../../components/Config/useSettingsState";
import { useTheme } from "../../context";
import type { Theme } from "../../context/ThemeContext";
import { useKeyboardScope } from "../../keyboard";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { PageHeader, SavedChip } from "../ui";
import { SettingsNav } from "./SettingsNav";
import {
  DEFAULT_SETTINGS_PAGE,
  SETTINGS_PAGES,
  resolveSettingsTarget,
  pickActiveSection,
  searchSettingsPages,
  type SettingsPageDef,
  type SettingsPageId,
} from "./settingsModel";
import { AgentsPage } from "./pages/AgentsPage";
import { TerminalPage } from "./pages/TerminalPage";
import { WorktreesPage } from "./pages/WorktreesPage";
import { AppearancePage } from "./pages/AppearancePage";
import { GeneralPage } from "./pages/GeneralPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { ShortcutsPage } from "./pages/ShortcutsPage";
import { SystemPage } from "./pages/SystemPage";
import { AgentVoicePage, AIProvidersPage, VoiceControlPage, VoiceInputPage } from "./pages/voice";
import { applyThemePreview } from "./themePreview";
import "./orbit-settings.css";

const VOICE_SAVE_EVENTS = [
  "grove:audio-settings-changed",
  "grove:voice-control-settings-changed",
  "grove:speaking-profiles-changed",
  "grove:providers-changed",
] as const;

/** Sticky header height; jumps land a section just below it. */
const HEADER_OFFSET = 76;
/** Scroll-spy pauses while a sub-section jump is smooth-scrolling. */
const JUMP_LOCK_MS = 700;
/** Overflow smaller than this doesn't count as "needs scrolling". */
const OVERFLOW_TOLERANCE = 4;

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function renderPage(pageId: SettingsPageId, settings: SettingsState, onPreviewTheme: (theme: Theme | null) => void) {
  switch (pageId) {
    case "agents": return <AgentsPage settings={settings} />;
    case "worktrees": return <><TerminalPage settings={settings} /><WorktreesPage settings={settings} /></>;
    case "general": return <GeneralPage settings={settings} />;
    case "appearance": return <AppearancePage onPreviewTheme={onPreviewTheme} />;
    case "shortcuts": return <ShortcutsPage />;
    case "notifications": return <NotificationsPage settings={settings} />;
    case "system": return <SystemPage />;
    case "voice": return <VoiceInputPage />;
    case "vcontrol": return <VoiceControlPage />;
    case "avoice": return <AgentVoicePage />;
    case "providers": return <AIProvidersPage />;
  }
}

export function OrbitSettingsPage() {
  // Same scope as the Workbench page so `settings.close` (Escape) still works.
  useKeyboardScope("settings", true);
  const settings = useSettingsState();
  const { webTerminalMode, isTauriGui, depStates, isChecking, isTerminalAvailable, baseAgentsLoading, isChatAvailable } = settings;
  const { theme: currentTheme } = useTheme();
  // Hover preview of a theme, applied to this page only and never saved.
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null);
  const previewing = previewTheme && previewTheme.id !== currentTheme.id ? previewTheme : null;
  // Hover preview covers the whole window, sidebar included, and is undone on
  // leave or unmount; nothing is saved.
  useEffect(() => (previewing ? applyThemePreview(previewing) : undefined), [previewing]);

  const [pageId, setPageId] = useState<SettingsPageId>(DEFAULT_SETTINGS_PAGE);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [spySub, setSpySub] = useState<string | null>(null);
  const [condensed, setCondensed] = useState(false);
  // Sub-section links only help when the page doesn't fit on one screen.
  const [contentOverflows, setContentOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const lockUntilRef = useRef(0);
  const pendingJumpRef = useRef<string | undefined>(undefined);

  // Sub-sections that only render in some states: the terminal layout needs
  // multiplexer mode, the window shortcut needs the desktop app.
  const pages = useMemo<SettingsPageDef[]>(() => SETTINGS_PAGES.map((page) => {
    const hidden = page.id === "worktrees" && webTerminalMode !== "multiplexer" ? "layout"
      : page.id === "general" && !isTauriGui ? "window"
        : null;
    return hidden ? { ...page, subs: page.subs.filter((sub) => sub.id !== hidden) } : page;
  }), [webTerminalMode, isTauriGui]);
  const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0];
  const hits = useMemo(() => searchSettingsPages(pages, query), [pages, query]);
  const activeSub = page.subs.some((sub) => sub.id === spySub) ? spySub ?? undefined : page.subs[0]?.id;

  const attention = useMemo(() => {
    const ids = new Set<SettingsPageId>();
    if (Object.keys(depStates).length > 0 && !isChecking && !isTerminalAvailable) ids.add("worktrees");
    if (!baseAgentsLoading && !isChatAvailable) ids.add("agents");
    return ids;
  }, [depStates, isChecking, isTerminalAvailable, baseAgentsLoading, isChatAvailable]);

  const jumpTo = useCallback((subId: string) => {
    const container = contentRef.current;
    const anchor = container?.querySelector<HTMLElement>(`[data-anchor="${subId}"]`);
    setSpySub(subId);
    if (!container || !anchor) return;
    lockUntilRef.current = Date.now() + JUMP_LOCK_MS;
    const top = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - HEADER_OFFSET), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  const selectPage = useCallback((nextId: SettingsPageId, subId?: string) => {
    if (nextId === pageId) {
      if (subId) jumpTo(subId);
      return;
    }
    pendingJumpRef.current = subId;
    contentRef.current?.scrollTo({ top: 0 });
    setPageId(nextId);
    setSpySub(null);
    setCondensed(false);
  }, [jumpTo, pageId]);

  const updateSpy = useCallback(() => {
    const container = contentRef.current;
    if (!container || Date.now() < lockUntilRef.current) return;
    const containerTop = container.getBoundingClientRect().top;
    const anchors = Array.from(container.querySelectorAll<HTMLElement>("[data-anchor]")).map((element) => ({
      id: element.dataset.anchor ?? "",
      top: element.getBoundingClientRect().top - containerTop + container.scrollTop,
    }));
    setSpySub(pickActiveSection(anchors, container.scrollTop, container.clientHeight, container.scrollHeight) ?? null);
  }, []);

  // Re-measured whenever the container or its content resizes, which covers
  // page switches and sections appearing (e.g. Terminal → Layout).
  useEffect(() => {
    const container = contentRef.current;
    const inner = innerRef.current;
    if (!container || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContentOverflows(container.scrollHeight - container.clientHeight > OVERFLOW_TOLERANCE);
      // Sections that finish loading shift the anchors without a scroll event.
      if (container.scrollTop > 0) updateSpy();
    });
    observer.observe(container);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [updateSpy]);

  // Condensing the header shortens the page. When the content only just
  // overflows, that can remove the overflow, snap scrollTop back to 0 and
  // expand the header again, looping. Padding the bottom by however much the
  // header has shrunk keeps the scroll range constant.
  useEffect(() => {
    const container = contentRef.current;
    const inner = innerRef.current;
    const header = container?.querySelector<HTMLElement>(".oui-hdr");
    if (!container || !header || !inner || typeof ResizeObserver === "undefined") return;
    let expandedHeight = header.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = header.offsetHeight;
      if (!header.classList.contains("is-condensed")) expandedHeight = height;
      inner.style.setProperty("--ost-hdr-shrink", `${Math.max(0, expandedHeight - height)}px`);
      // The shrinking header also moves every anchor up, with no scroll event.
      if (container.scrollTop > 0) updateSpy();
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [pageId, updateSpy]);

  // A search hit on a sub-section jumps there once the new page has rendered.
  useEffect(() => {
    const subId = pendingJumpRef.current;
    if (!subId) return;
    pendingJumpRef.current = undefined;
    const frame = window.requestAnimationFrame(() => jumpTo(subId));
    return () => window.cancelAnimationFrame(frame);
  }, [pageId, jumpTo]);

  const handleScroll = () => {
    const container = contentRef.current;
    if (!container) return;
    setCondensed(container.scrollTop > 4);
    updateSpy();
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    setCursor(0);
  };
  useEscapeScope(query !== "", () => handleQueryChange(""));

  // "/" focuses search from anywhere on the page that isn't a text field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Voice & AI pages save through their own hooks, which announce each save.
  const [voiceSaves, setVoiceSaves] = useState(0);
  useEffect(() => {
    const bump = () => setVoiceSaves((count) => count + 1);
    for (const name of VOICE_SAVE_EVENTS) window.addEventListener(name, bump);
    return () => {
      for (const name of VOICE_SAVE_EVENTS) window.removeEventListener(name, bump);
    };
  }, []);

  // `help.openShortcutSettings` sets #shortcuts; AI entry points set #settings-<id>.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      const target = hash === "#shortcuts" ? "shortcuts" : hash.startsWith("#settings-") ? hash.slice("#settings-".length) : null;
      // Legacy Workbench section ids (terminal, browserControl, ...) land where they live now.
      const resolved = target ? resolveSettingsTarget(target) : null;
      if (!resolved) return;
      selectPage(resolved.pageId, resolved.subId);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [selectPage]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="ost orbit-ui">
        <SettingsNav
          pages={pages}
          hits={hits}
          activePage={page.id}
          activeSub={activeSub}
          attention={attention}
          query={query}
          onQueryChange={handleQueryChange}
          cursor={cursor}
          onCursorChange={setCursor}
          onSelect={selectPage}
          onJump={jumpTo}
          searchRef={searchRef}
          showSubs={contentOverflows}
        />
        <div
          ref={contentRef}
          className="ost-content"
          style={{ "--ost-glow": page.hue.glow } as CSSProperties}
          onScroll={handleScroll}
        >
          {/* Outside the column so the condensed bar spans the whole pane. */}
          <PageHeader
            icon={page.icon}
            hue={page.hue}
            title={page.title}
            condensed={condensed}
            aside={(
              <>
                {previewing ? <span className="oui-chipnote ost-previewing" role="status"><i />Previewing {previewing.name}</span> : null}
                <SavedChip count={settings.savedCount + voiceSaves} />
              </>
            )}
          />
          <div ref={innerRef} className="ost-inner">
            <div key={page.id} className="ost-sec">
              {renderPage(page.id, settings, setPreviewTheme)}
            </div>
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
