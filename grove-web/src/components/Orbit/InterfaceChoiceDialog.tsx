import { useState } from "react";
import { Sparkles } from "lucide-react";
import { patchConfig } from "../../api";
import { useConfig } from "../../context";
import { DialogShell } from "../ui/DialogShell";
import { Button } from "../ui/Button";
import "./interface-choice.css";

type InterfaceChoice = "orbit" | "workbench";

const bar = "rounded-[3px] bg-[var(--color-border)]";
const block = "rounded-[5px] border border-[var(--color-border)] bg-[var(--color-bg)]";

function OrbitPreview() {
  return (
    <>
      <div className="flex w-[22%] flex-col gap-[5px]">
        <div className={`${bar} h-1.5 w-[70%]`} />
        <div className={`${bar} h-[5px]`} />
        <div className={`${bar} h-[5px] w-[80%]`} />
        <div className={`${bar} h-[5px] w-[60%]`} />
      </div>
      <div className={`${block} flex flex-1 flex-col items-center justify-end gap-1.5 p-2`}>
        <div className={`${bar} h-[5px] w-[60%] self-end`} />
        <div className={`${bar} h-[5px] w-[75%] self-start`} />
        <div className="h-[22px] w-[90%] rounded-[7px] border border-[var(--color-border)]" />
      </div>
    </>
  );
}

function WorkbenchPreview() {
  return (
    <>
      <div className="flex w-[18%] flex-col gap-[5px]">
        <div className={`${bar} h-[5px]`} />
        <div className={`${bar} h-[5px] w-[70%]`} />
        <div className={`${bar} h-[5px] w-[85%]`} />
      </div>
      <div className={`${block} w-[24%]`} />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className={`${block} flex-1`} />
        <div className={`${block} flex-1`} />
      </div>
      <div className={`${block} w-[20%]`} />
    </>
  );
}

const OPTIONS: { id: InterfaceChoice; name: string; description: string; isNew?: boolean; Preview: () => React.ReactElement }[] = [
  { id: "orbit", name: "Orbit", description: "Chat first. Open panels when you need them.", isNew: true, Preview: OrbitPreview },
  { id: "workbench", name: "Workbench", description: "Multi-panel IDE. Run many tasks side by side.", Preview: WorkbenchPreview },
];

/**
 * First-run interface picker. Shown on any page until `web.interface` has been
 * saved once; saving the choice is what marks it as seen, so there is no
 * dismiss path that leaves it unset.
 */
export function InterfaceChoiceDialog() {
  const { config, refresh } = useConfig();
  const [choice, setChoice] = useState<InterfaceChoice>("orbit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOpen = !!config && config.web.interface == null;

  const confirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await patchConfig({ web: { interface: choice } });
      await refresh();
    } catch {
      setError("Couldn't save your choice. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const selected = OPTIONS.find((option) => option.id === choice)!;

  return (
    <DialogShell isOpen={isOpen} onClose={() => {}} maxWidth="max-w-[560px]" zIndex={60} variant="centered">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-6 shadow-2xl">
        <span className="interface-choice__new inline-flex items-center gap-1.5 rounded-full border border-[var(--color-highlight)]/25 bg-[var(--color-highlight)]/10 py-1 pl-1 pr-2.5 text-xs font-medium text-[var(--color-highlight)]">
          <span className="rounded-full bg-[var(--color-highlight)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-white">New</span>
          Orbit, a chat-first Grove
        </span>
        <h2 className="mt-3 text-lg font-semibold text-[var(--color-text)]">Choose how you work in Grove</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">You can switch anytime in Settings.</p>
        <div className="mt-5 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Interface">
          {OPTIONS.map(({ id, name, description, isNew, Preview }) => {
            const active = id === choice;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setChoice(id)}
                className={`flex flex-col gap-2.5 rounded-xl bg-[var(--color-bg)] text-left transition-colors ${active ? "border-2 border-[var(--color-highlight)] p-[13px]" : "border border-[var(--color-border)] p-3.5 hover:border-[var(--color-text-muted)]"}`}
              >
                <div className={`flex h-[132px] gap-1.5 rounded-lg border border-[var(--color-border)] p-2 ${isNew ? "interface-choice__orbit-preview" : "bg-[var(--color-bg-secondary)]"}`}>
                  <Preview />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-medium text-[var(--color-text)]">{name}</span>
                  {isNew && (
                    <>
                      <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-highlight)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                        <Sparkles className="h-3 w-3" />
                        New
                      </span>
                      <span className="text-xs text-[var(--color-text-muted)]">Recommended</span>
                    </>
                  )}
                </div>
                <span className="text-[13px] leading-snug text-[var(--color-text-muted)]">{description}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex items-center justify-end gap-3">
          {error && <span className="mr-auto text-[13px] text-[var(--color-error)]">{error}</span>}
          <Button onClick={() => { void confirm(); }} disabled={saving}>
            Continue with {selected.name}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
