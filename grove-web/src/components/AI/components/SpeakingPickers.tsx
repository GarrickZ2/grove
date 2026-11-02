import { createPortal } from "react-dom";
import { useMemo, type ReactNode } from "react";
import { Check, ChevronDown, Headphones, Loader2, Pause, Play, Search, Volume2 } from "lucide-react";
import { useDropdown } from "../../../hooks/useDropdown";
import { Button } from "../../ui/Button";
import { VoiceIdentityIcon } from "./VoiceIdentityIcon";
import { voiceMeta, voiceTypeFilters, type VoiceTypeFilter } from "../useSpeakingProfileEditor";
import type { SpeakingProviderField, SpeakingVoice } from "../types";

/* Voice and model pickers for Speaking Profiles, shared by the Workbench
   AgentVoicePanel and Orbit's Agent voice page. */

export function RichVoicePicker({ voices, value, disabled, loading, search, onOpen, onSearchChange, voiceType, onVoiceTypeChange, hasMore, totalCount, playingVoiceId, onPreview, onLoadMore, onChange, disabledLabel = "Connect Provider to browse voices" }: {
  voices: SpeakingVoice[]; value: string; disabled: boolean; loading: boolean; search: string; onOpen: () => void; onSearchChange: (value: string) => void; voiceType: VoiceTypeFilter; onVoiceTypeChange: (value: VoiceTypeFilter) => void; hasMore: boolean; totalCount?: number; playingVoiceId: string | null; onPreview: (voice: SpeakingVoice) => void; onLoadMore: () => void; onChange: (voice: SpeakingVoice) => void; disabledLabel?: string;
}) {
  const { containerRef, dropdownRef, isOpen, position, setIsOpen, triggerRef } = useDropdown();
  const selected = voices.find((voice) => voice.voiceId === value);
  const groupedVoices = useMemo(() => {
    const order = ["Personal", "Saved", "Professional", "Default", "Workspace", "Other"];
    const groups = new Map<string, SpeakingVoice[]>();
    for (const voice of voices) {
      const raw = voice.source || (voice.category === "professional" ? "Professional" : "Other");
      const group = raw === "Workspace" && voice.category === "professional" ? "Professional" : raw;
      groups.set(group, [...(groups.get(group) ?? []), voice]);
    }
    return [...groups.entries()].sort(([a], [b]) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
  }, [voices]);
  const dropdownWidth = typeof window === "undefined" || !position ? 640 : Math.min(Math.max(position.width, 640), window.innerWidth - 32);
  const dropdownLeft = typeof window === "undefined" || !position ? 16 : Math.max(16, Math.min(position.left, window.innerWidth - dropdownWidth - 16));
  const triggerTop = position ? position.top - 62 : 0;
  const spaceBelow = typeof window === "undefined" || !position ? 520 : window.innerHeight - position.top - 12;
  const spaceAbove = position ? triggerTop - 12 : 0;
  const placeAbove = Boolean(position && spaceBelow < 360 && spaceAbove > spaceBelow);
  const dropdownHeight = typeof window === "undefined" ? 520 : Math.min(520, Math.max(280, placeAbove ? spaceAbove : spaceBelow));
  const dropdownTop = position ? (placeAbove ? Math.max(12, triggerTop - dropdownHeight - 6) : position.top) : 12;

  return <div ref={containerRef}>
    <button ref={triggerRef} type="button" disabled={disabled} onClick={() => { if (!isOpen) onOpen(); setIsOpen((open) => !open); }} className={`flex h-14 w-full items-center gap-3 rounded-xl border px-3 text-left transition-colors ${disabled ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-60" : isOpen ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5 ring-2 ring-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-text-muted)]"}`}>
      {selected ? <VoiceAvatar voice={selected} size="md" /> : <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"><Volume2 className="h-4 w-4" /></div>}
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--color-text)]">{selected?.name ?? (disabled ? disabledLabel : "Choose a voice")}</div>{selected && <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{voiceMeta(selected).join(" · ") || "Voice details unavailable"}</div>}</div>
      <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
    </button>
    {isOpen && position && createPortal(<div ref={dropdownRef} role="dialog" aria-label="Choose a voice" style={{ position: "fixed", top: dropdownTop, left: dropdownLeft, width: dropdownWidth, height: dropdownHeight, zIndex: 9999 }} className="isolate flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
      <div className="relative z-20 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        <div className="flex h-11 items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 focus-within:border-[var(--color-highlight)]"><Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><input autoFocus value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search name, language, accent, or use case..." className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]" />{loading && <Loader2 className="h-4 w-4 animate-spin text-[var(--color-highlight)]" />}</div>
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">{voiceTypeFilters.map((filter) => <button key={filter.value} type="button" onClick={() => onVoiceTypeChange(filter.value)} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${voiceType === filter.value ? "bg-[var(--color-text)] text-[var(--color-bg)]" : "bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>{filter.label}</button>)}</div>
      </div>
      <div className="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--color-bg)]">
        {!loading && voices.length === 0 && <div className="px-5 py-10 text-center"><Headphones className="mx-auto h-6 w-6 text-[var(--color-text-muted)]" /><div className="mt-2 text-sm font-medium text-[var(--color-text)]">No voices found</div><div className="mt-1 text-xs text-[var(--color-text-muted)]">Try another search or voice group.</div></div>}
        {groupedVoices.map(([group, items]) => <div key={group}><div className="sticky top-0 z-10 border-b border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[var(--color-bg)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{group}</div>{items.map((voice) => {
          const isSelected = voice.voiceId === value;
          const isPlaying = voice.voiceId === playingVoiceId;
          const meta = voiceMeta(voice);
          return <button key={voice.voiceId} type="button" onClick={() => { onChange(voice); setIsOpen(false); }} className={`group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${isSelected ? "bg-[var(--color-highlight)]/8" : "hover:bg-[var(--color-bg-secondary)]"}`}>
            <span role="button" aria-label={isPlaying ? `Pause ${voice.name}` : `Preview ${voice.name}`} aria-disabled={!voice.previewUrl && !isSelected} onClick={(event) => { event.stopPropagation(); if (voice.previewUrl || isSelected) onPreview(voice); }} className={`relative shrink-0 rounded-full ${!voice.previewUrl && !isSelected ? "cursor-not-allowed opacity-45" : ""}`}><VoiceAvatar voice={voice} size="sm" /><span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100">{isPlaying ? <Pause className="h-3 w-3 fill-current" /> : <Play className="ml-0.5 h-3 w-3 fill-current" />}</span></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--color-text)]">{voice.name}</span><span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{voice.description || meta.join(" · ") || "No description provided"}</span></span>
            <span className="hidden max-w-[42%] shrink-0 items-center justify-end gap-1.5 sm:flex">{meta.slice(0, 2).map((item) => <MetaPill key={item}>{item}</MetaPill>)}{meta.length > 2 && <MetaPill>+{meta.length - 2} more</MetaPill>}</span>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">{isSelected && <Check className="h-4 w-4 text-[var(--color-highlight)]" />}</span>
          </button>;
        })}</div>)}
      </div>
      <div className="relative z-20 flex shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5"><span className="text-[11px] text-[var(--color-text-muted)]">{totalCount === undefined ? `${voices.length} available` : `${totalCount} available voices`}</span>{hasMore && <Button variant="secondary" size="sm" onClick={onLoadMore} disabled={loading}>{loading ? "Loading" : "Find more voices"}</Button>}</div>
    </div>, document.body)}
  </div>;
}

export function RichModelPicker({ options, value, disabled, onChange }: { options: NonNullable<SpeakingProviderField["options"]>; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { containerRef, dropdownRef, isOpen, position, setIsOpen, triggerRef } = useDropdown();
  const selected = options.find((option) => option.value === value);
  const dropdownWidth = typeof window === "undefined" || !position ? 560 : Math.min(Math.max(position.width, 560), window.innerWidth - 32);
  const dropdownLeft = typeof window === "undefined" || !position ? 16 : Math.max(16, Math.min(position.left, window.innerWidth - dropdownWidth - 16));
  const triggerTop = position ? position.top - 62 : 0;
  const desiredHeight = Math.min(420, options.length * 108 + 16);
  const spaceBelow = typeof window === "undefined" || !position ? desiredHeight : window.innerHeight - position.top - 12;
  const spaceAbove = position ? triggerTop - 12 : 0;
  const placeAbove = Boolean(position && spaceBelow < Math.min(240, desiredHeight) && spaceAbove > spaceBelow);
  const dropdownMaxHeight = typeof window === "undefined" ? desiredHeight : Math.min(desiredHeight, Math.max(180, placeAbove ? spaceAbove : spaceBelow));
  const dropdownTop = position ? (placeAbove ? Math.max(12, triggerTop - dropdownMaxHeight - 6) : position.top) : 12;
  return <div ref={containerRef}>
    <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setIsOpen((open) => !open)} className={`flex h-14 w-full items-center justify-between gap-3 rounded-xl border px-3.5 text-left transition-colors ${disabled ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-60" : isOpen ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5 ring-2 ring-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-text-muted)]"}`}>
      <span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold text-[var(--color-text)]">{selected?.label ?? "Choose a model"}</span>{selected?.badge && <MetaPill>{selected.badge}</MetaPill>}</span>{selected?.description && <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">{selected.description}</span>}</span><ChevronDown className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
    </button>
    {isOpen && position && createPortal(<div ref={dropdownRef} role="dialog" aria-label="Choose a model" style={{ position: "fixed", top: dropdownTop, left: dropdownLeft, width: dropdownWidth, maxHeight: dropdownMaxHeight, zIndex: 9999 }} className="overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 shadow-[0_24px_70px_rgba(15,23,42,0.22)]">{options.map((option) => {
      const isSelected = option.value === value;
      return <button key={option.value} type="button" onClick={() => { onChange(option.value); setIsOpen(false); }} className={`mb-1 flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-3.5 text-left transition-colors last:mb-0 ${isSelected ? "border-[var(--color-highlight)]/35 bg-[var(--color-highlight)]/7" : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"}`}><span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-[var(--color-text)]">{option.label}</span>{option.badge && <MetaPill>{option.badge}</MetaPill>}</span>{option.description && <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">{option.description}</span>}{option.metadata && option.metadata.length > 0 && <span className="mt-2 flex flex-wrap gap-1.5">{option.metadata.slice(0, 3).map((item) => <MetaPill key={item}>{item}</MetaPill>)}{option.metadata.length > 3 && <MetaPill>+{option.metadata.length - 3} more</MetaPill>}</span>}</span><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)]">{isSelected && <Check className="h-3.5 w-3.5 text-[var(--color-highlight)]" />}</span></button>;
    })}</div>, document.body)}
  </div>;
}

export function MetaPill({ children }: { children: ReactNode }) {
  return <span className="max-w-40 truncate rounded-full bg-[var(--color-bg-secondary)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-muted)]">{children}</span>;
}
export function VoiceAvatar({ voice, size }: { voice: SpeakingVoice; size: "sm" | "md" | "xl" }) {
  return <VoiceIdentityIcon kind="voice" id={voice.voiceId} size={size} className={size === "xl" ? "ring-8 ring-[var(--color-bg)] [@media(max-height:760px)]:ring-4" : ""} />;
}
