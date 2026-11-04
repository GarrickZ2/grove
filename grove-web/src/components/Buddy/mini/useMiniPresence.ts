import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useReducedMotion } from "framer-motion";
import type { BuddyStatus } from "../../../api/buddies";

/** Idle and left alone for this long, it falls asleep. */
export const SLEEP_AFTER_MS = 5 * 60 * 1000;
/** Long enough for the two blinks and the hop in buddy-mini.css. */
const WAKE_MS = 900;

interface CursorLook { x: number; y: number; near: boolean; over: boolean }

/**
 * What the collapsed avatar is doing on its own: watching a nearby cursor,
 * sleeping when nobody has been around, waking up when somebody is. Working
 * and waiting keep their status animations, so neither is mistaken for mood.
 * Eye positions go straight to CSS variables: they change ten times a second.
 */
export function useMiniPresence({ collapsed, tone, activity, lively, bubble }: { collapsed: boolean; tone: BuddyStatus; activity: string | null | undefined; lively: boolean; bubble: RefObject<HTMLElement | null> }) {
  const reduceMotion = useReducedMotion();
  const [sleeping, setSleeping] = useState(false);
  const [waking, setWaking] = useState(false);
  const [following, setFollowing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const resting = collapsed && tone === "idle";
  const asleep = useRef(false);
  const sleepTimer = useRef<number | undefined>(undefined);
  const wakeTimer = useRef<number | undefined>(undefined);
  const setAsleep = useCallback((value: boolean) => { asleep.current = value; setSleeping(value); }, []);
  /** Somebody's around: wake if needed, and start the wait for sleep over. */
  const notice = useCallback(() => {
    window.clearTimeout(sleepTimer.current);
    sleepTimer.current = window.setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    if (!asleep.current) return;
    setAsleep(false);
    setWaking(true);
    window.clearTimeout(wakeTimer.current);
    wakeTimer.current = window.setTimeout(() => setWaking(false), WAKE_MS);
  }, [setAsleep]);
  useEffect(() => {
    if (!resting) {
      window.clearTimeout(sleepTimer.current);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- leaving rest ends sleep at once
      setAsleep(false);
      return;
    }
    notice();
    return () => window.clearTimeout(sleepTimer.current);
  }, [resting, activity, notice, setAsleep]);
  useEffect(() => () => window.clearTimeout(wakeTimer.current), []);

  const tracking = resting && lively && !reduceMotion;
  useEffect(() => {
    if (!tracking) return;
    let stop: (() => void) | undefined, cancelled = false;
    void listen<CursorLook>("buddy-mini:cursor", ({ payload }) => {
      if (payload.near) notice();
      setFollowing(payload.near);
      setHovered(payload.over);
      bubble.current?.style.setProperty("--look-x", String(payload.x));
      bubble.current?.style.setProperty("--look-y", String(payload.y));
    }).then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; }).catch(() => {});
    void invoke("buddy_mini_track_cursor", { enabled: true }).catch(() => {});
    return () => {
      cancelled = true; stop?.();
      setFollowing(false);
      setHovered(false);
      void invoke("buddy_mini_track_cursor", { enabled: false }).catch(() => {});
    };
  }, [tracking, notice, bubble]);
  return { sleeping, waking, following: following && !sleeping, hovered, notice };
}
