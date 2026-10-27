import { useEffect, useRef, useState } from "react";
import {
  cancelMcpPackageProbe,
  getMcpPackageProbe,
  probeMcpPackage,
  type McpPackageProbe,
  type McpPackageProbeInput,
} from "../../api/extensions";
import { mcpErrorText } from "./useMcpConnection";

export function useMcpPackageConnection() {
  const [probe, setProbe] = useState<McpPackageProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const job = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = () => {
    revision.current++;
    clearTimeout(timer.current);
    const id = job.current;
    job.current = null;
    if (id) void cancelMcpPackageProbe(id).catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);
  const reset = () => {
    stop();
    setProbe(null);
    setError(null);
    setBusy(false);
  };
  const check = async (input: McpPackageProbeInput) => {
    stop();
    const generation = revision.current;
    const current = () => mounted.current && revision.current === generation;
    setBusy(true);
    setError(null);
    setProbe(null);
    const publish = (value: McpPackageProbe) => {
      if (!current()) return;
      setProbe(value);
      if (value.status !== "pending") {
        setBusy(false);
        setError(value.error);
      }
    };
    const fail = (cause: unknown) => {
      if (!current()) return;
      stop();
      setBusy(false);
      setError(mcpErrorText(cause));
    };
    const poll = async (id: string) => {
      try {
        const value = await getMcpPackageProbe(id);
        if (!current()) return;
        publish(value);
        if (value.status === "pending")
          timer.current = setTimeout(() => void poll(id), 750);
      } catch (cause) {
        fail(cause);
      }
    };
    try {
      const value = await probeMcpPackage(input);
      if (!current()) {
        void cancelMcpPackageProbe(value.id).catch(() => {});
        return;
      }
      job.current = value.id;
      publish(value);
      if (value.status === "pending")
        timer.current = setTimeout(() => void poll(value.id), 500);
    } catch (cause) {
      fail(cause);
    }
  };
  return { probe, busy, error, check, reset };
}
