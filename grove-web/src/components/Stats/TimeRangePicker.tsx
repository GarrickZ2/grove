import { useState, useRef, useEffect } from "react";
import { Calendar, ChevronDown, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface PresetRange {
  id: string;
  label: string;
}

export interface TimeRangeValue {
  label: string;
  presetId?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}

const PRESETS: PresetRange[] = [
  { id: "7d",         label: "Last 7 days"  },
  { id: "14d",        label: "Last 14 days" },
  { id: "30d",        label: "Last 30 days" },
  { id: "90d",        label: "Last 90 days" },
  { id: "this-week",  label: "This week"    },
  { id: "this-month", label: "This month"   },
  { id: "this-year",  label: "This year"    },
  { id: "all",        label: "All time"     },
];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

interface TimeRangePickerProps {
  value: TimeRangeValue;
  onChange: (v: TimeRangeValue) => void;
}

export function TimeRangePicker({ value, onChange }: TimeRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(daysAgoStr(30));
  const [customTo, setCustomTo] = useState(todayStr());
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectPreset = (preset: PresetRange) => {
    onChange({ label: preset.label, presetId: preset.id });
    setOpen(false);
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    const label = `${customFrom} → ${customTo}`;
    onChange({ label, from: customFrom, to: customTo });
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative select-none">
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
          open
            ? "border-[var(--color-highlight)] text-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
            : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
        }`}
      >
        <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="max-w-[180px] truncate">{value.label}</span>
        <ChevronDown
          className="w-3 h-3 flex-shrink-0 transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {/* Popover */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full mt-1 z-50 flex rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl overflow-hidden"
            style={{ minWidth: 380 }}
          >
            {/* Left: Custom range */}
            <div className="w-44 p-4 border-r border-[var(--color-border)] flex flex-col gap-3 select-none">
              <p className="text-xs font-semibold text-[var(--color-text)] uppercase tracking-wide select-none">
                Custom Range
              </p>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--color-text-muted)] select-none">Start</label>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || todayStr()}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text)] text-xs px-2 py-1.5 outline-none focus:border-[var(--color-highlight)]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--color-text-muted)] select-none">End</label>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={todayStr()}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text)] text-xs px-2 py-1.5 outline-none focus:border-[var(--color-highlight)]"
                />
              </div>
              <button
                onClick={applyCustom}
                disabled={!customFrom || !customTo}
                className="w-full py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: "var(--color-highlight)",
                  color: "#fff",
                }}
              >
                Apply
              </button>
            </div>

            {/* Right: Presets */}
            <div className="flex-1 p-2 select-none">
              <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide px-2 py-1.5 select-none">
                Quick Select
              </p>
              {PRESETS.map((preset) => {
                const isActive = value.presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() => selectPreset(preset)}
                    className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive
                        ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                    }`}
                  >
                    {preset.label}
                    {isActive && <Check className="w-3 h-3 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
