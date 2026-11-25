import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, ChevronsUpDown, Monitor, Pencil, Plus } from "lucide-react";
import {
  getMachines, needsMachineLogin, openMachine, pairMachine, refreshMachineSession, removeMachine, updateMachine,
  type MachineIcon, type MachineProfile, type MachinesOverview, type PairedMachine,
} from "../../api/machines";
import { Button, DialogBody, DialogField, DialogFoot, DialogHead, DialogPanel, HoldButton, OrbitDialogLayer, StatusDot, usePopover, type StatusTone } from "../../orbit/ui";
import { useConfig } from "../../context";
import { requestAt, setMachineApiBase } from "../../api/client";
import { isTauriShell, signInToMachine } from "../../utils/tauriShell";
import { homeNote, MACHINE_ICONS, machineAddress, machineNote, parseHeaders } from "./orbitMachines";
import { isIosClient } from "../../utils/platform";
import {
  forgetIosServer, iosServerHost, iosServerOrigin, listIosServers, openIosServer, probeIosServer, renameIosServer,
  type IosReach, type IosServer, type IosServers,
} from "../../ios/servers";
import "./orbit-machine-menu.css";

const REFRESH_MS = 10_000;

function MachineGlyph({ icon }: { icon: string }) {
  const Icon = MACHINE_ICONS.find((option) => option.id === icon)?.icon ?? Monitor;
  return <Icon size={16} strokeWidth={1.6} />;
}

const message = (error: unknown) => (error as { message?: string })?.message || "Something went wrong";

type DialogState = { mode: "connect"; url?: string } | { mode: "edit"; machine: MachineProfile; isThis: boolean };

function MachineDialog({ state, onClose, onChanged }: {
  state: DialogState;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [step, setStep] = useState(state);
  const [url, setUrl] = useState(state.mode === "connect" ? state.url ?? "" : "");
  const [passkey, setPasskey] = useState("");
  const [headers, setHeaders] = useState("");
  const [showHeaders, setShowHeaders] = useState(false);
  const editing = step.mode === "edit" ? step.machine : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [icon, setIcon] = useState<MachineIcon>(editing?.icon ?? "server");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const typed = parseHeaders(headers);
      const machine = await pairMachine(url, passkey, typed).catch(async (reason) => {
        if (!needsMachineLogin(reason)) throw reason;
        if (!isTauriShell) {
          setShowHeaders(true);
          throw new Error("This machine is behind a sign-in page. Connect from the desktop app, or add the request headers that get past it.");
        }
        const cookie = await signInToMachine(machineAddress(url));
        return pairMachine(url, passkey, { ...typed, Cookie: cookie });
      });
      onChanged();
      // Name it right away, while the person knows which machine this is.
      setName(machine.name);
      setDescription(machine.description);
      setIcon(machine.icon);
      setStep({ mode: "edit", machine, isThis: false });
    });
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    void run(async () => {
      await updateMachine(editing.id, { name, description, icon });
      onChanged();
      onClose();
    });
  };

  const remove = () => {
    if (!editing) return;
    void run(async () => {
      await removeMachine(editing.id);
      onChanged();
      onClose();
    });
  };

  const notice = error ? <p className="orbit-machine-error" role="alert">{error}</p> : null;

  return (
    <OrbitDialogLayer open onClose={onClose} label={step.mode === "connect" ? "Connect a machine" : "Edit machine"}>
      {step.mode === "connect" ? (
        <DialogPanel onSubmit={connect}>
          <DialogHead title="Connect a machine" description={<>Run <code>grove remote</code> there, then sign in once. Both machines will trust each other.</>} />
          <DialogBody>
            <DialogField label="Address">
              <input className="oui-field" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="192.168.1.20:3001" autoFocus autoComplete="off" spellCheck={false} />
            </DialogField>
            <DialogField label="Passkey">
              <input className="oui-field" type="password" value={passkey} onChange={(event) => setPasskey(event.target.value)} autoComplete="off" />
            </DialogField>
            {showHeaders ? (
              <DialogField label="Request headers" note="One per line, for a service in front of the machine.">
                <textarea className="oui-dlg-textarea" rows={3} value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder="Header-Name: value" spellCheck={false} />
              </DialogField>
            ) : (
              <button type="button" className="orbit-machine-link" onClick={() => setShowHeaders(true)}>Add request headers</button>
            )}
            {notice}
          </DialogBody>
          <DialogFoot>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || !url.trim()}>{busy ? "Connecting…" : "Connect"}</Button>
          </DialogFoot>
        </DialogPanel>
      ) : (
        <DialogPanel onSubmit={save}>
          <DialogHead title={step.isThis ? "This machine" : "Edit machine"} description="Buddies read this to know what each machine is for." />
          <DialogBody>
            <DialogField label="Name">
              <input className="oui-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus autoComplete="off" />
            </DialogField>
            <DialogField label="Description">
              <textarea className="oui-dlg-textarea" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="What it's for and what it can do" />
            </DialogField>
            <DialogField label="Icon" as="div">
              <div className="orbit-machine-icons" role="radiogroup" aria-label="Icon">
                {MACHINE_ICONS.map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" role="radio" aria-checked={icon === id} aria-label={label} title={label} className={icon === id ? "is-selected" : ""} onClick={() => setIcon(id)}><Icon size={17} strokeWidth={1.6} /></button>
                ))}
              </div>
            </DialogField>
            {notice}
          </DialogBody>
          <DialogFoot lead={step.isThis ? undefined : <HoldButton onConfirm={remove} disabled={busy} holdingLabel="Keep holding…">Hold to remove</HoldButton>}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>Save</Button>
          </DialogFoot>
        </DialogPanel>
      )}
    </OrbitDialogLayer>
  );
}

type IosDialogState = { mode: "add" } | { mode: "edit"; server: IosServer };

/** Add, rename or remove one of the servers the iOS app keeps. */
function IosServerDialog({ state, onClose, onChanged }: {
  state: IosDialogState;
  onClose: () => void;
  onChanged: () => void;
}) {
  const editing = state.mode === "edit" ? state.server : null;
  const [address, setAddress] = useState("");
  const [name, setName] = useState(editing?.name ?? "");
  const [found, setFound] = useState<IosReach | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check the address as it is typed, so a typo shows before Connect.
  useEffect(() => {
    if (editing) return;
    const server = iosServerOrigin(address);
    let live = true;
    const timer = window.setTimeout(() => {
      if (!server) { setFound(null); return; }
      void probeIosServer(server).then((answer) => { if (live) setFound(answer); });
    }, 500);
    return () => { live = false; window.clearTimeout(timer); };
  }, [address, editing]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); } catch (reason) { setError(message(reason)); setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (editing) {
        await renameIosServer(editing.id, name);
        onChanged();
        onClose();
      } else await openIosServer(iosServerOrigin(address), name.trim());
    });
  };
  const remove = () => {
    if (!editing) return;
    void run(async () => {
      await forgetIosServer(editing.id);
      onChanged();
      onClose();
    });
  };

  return (
    <OrbitDialogLayer open onClose={onClose} label={editing ? "Edit server" : "Add a server"}>
      <DialogPanel onSubmit={submit}>
        <DialogHead title={editing ? "Edit server" : "Add a server"} description={editing ? iosServerHost(editing.server) : <>Run <code>grove remote</code> on the computer, then enter the address it shows.</>} />
        <DialogBody>
          {editing ? null : (
            <DialogField label="Address" note={found === null ? undefined : found === "grove" ? "Found Grove" : found === "sign_in" ? "Found a sign-in page" : "No Grove answers here yet"}>
              <input className="oui-field" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="192.168.1.20:3001" autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} inputMode="url" />
            </DialogField>
          )}
          <DialogField label="Name">
            <input className="oui-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={editing ? undefined : "Optional"} autoFocus={!!editing} autoComplete="off" />
          </DialogField>
          {error ? <p className="orbit-machine-error" role="alert">{error}</p> : null}
        </DialogBody>
        <DialogFoot lead={editing ? <HoldButton onConfirm={remove} disabled={busy} holdingLabel="Keep holding…">Hold to remove</HoldButton> : undefined}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || (editing ? !name.trim() : !address.trim())}>{editing ? "Save" : busy ? "Connecting…" : "Connect"}</Button>
        </DialogFoot>
      </DialogPanel>
    </OrbitDialogLayer>
  );
}

function MachineRow({ machine, tone, note, current, disabled, onOpen, onEdit }: {
  machine: MachineProfile;
  tone: StatusTone;
  note: string;
  current: boolean;
  disabled: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  return (
    <div className={`orbit-machine-item${current ? " is-current" : ""}`}>
      <button type="button" role="menuitem" className="orbit-machine-open" disabled={disabled} onClick={onOpen}>
        <span className="orbit-machine-glyph"><MachineGlyph icon={machine.icon} /><StatusDot tone={tone} size="sm" className="orbit-machine-dot" /></span>
        <span className="orbit-machine-text"><b>{machine.name}</b>{note ? <span>{note}</span> : null}</span>
        {current ? <Check size={15} strokeWidth={1.8} className="orbit-machine-check" /> : null}
      </button>
      <button type="button" className="orbit-machine-edit" aria-label={`Edit ${machine.name}`} title="Edit" onClick={onEdit}><Pencil size={14} strokeWidth={1.6} /></button>
    </div>
  );
}

/** The sidebar's slot for the switcher, there only for those who turned it on. */
export function OrbitMachineEntry() {
  const { config } = useConfig();
  // The iOS app always offers its own servers here, in the same list.
  return config?.web?.multi_machine === true || isIosClient ? <OrbitMachineMenu /> : null;
}

/** The sidebar's machine switcher: which machine this window shows, and the others it can reach. */
export function OrbitMachineMenu({ pairedOnly = false }: {
  /** Stay out of the way until there is another machine to reach. */
  pairedOnly?: boolean;
}) {
  const [overview, setOverview] = useState<MachinesOverview | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ios, setIos] = useState<IosServers | null>(null);
  const [reach, setReach] = useState<Record<string, IosReach>>({});
  const [iosDialog, setIosDialog] = useState<IosDialogState | null>(null);
  const { open, close, toggle, rootRef } = usePopover<HTMLDivElement>();

  const refresh = useCallback(() => {
    getMachines().then(setOverview).catch(() => {});
    if (isIosClient) listIosServers().then(setIos).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Each open of the list checks which of the app's servers answer.
  useEffect(() => {
    if (!open || !ios) return;
    let live = true;
    for (const server of ios.servers) {
      if (server.id === ios.current) continue;
      void probeIosServer(server.server).then((answer) => { if (live) setReach((all) => ({ ...all, [server.id]: answer })); });
    }
    return () => { live = false; };
  }, [open, ios]);

  if (isIosClient ? !ios : !overview || (pairedOnly && overview.machines.length === 0)) return null;
  const home = overview?.this ?? { id: "", name: "", description: "", icon: "server" as MachineIcon };
  const current = overview?.current ?? home.id;
  const machines = overview?.machines ?? [];
  const atHome = current === home.id;
  const thisServer = ios?.servers.find((server) => server.id === ios.current);
  const shown = atHome ? (thisServer ? { ...home, name: thisServer.name } : home) : machines.find((machine) => machine.id === current) ?? home;
  const shownStatus = atHome ? "online" : machines.find((machine) => machine.id === current)?.status ?? "offline";
  const switchServer = (server: IosServer) => {
    setFailure(null);
    openIosServer(server.server, server.name).catch((reason) => setFailure(`Can't reach ${server.name}: ${message(reason)}`));
  };

  const goHome = () => setMachineApiBase(null);
  const switchTo = async (machine: PairedMachine) => {
    setFailure(null);
    try {
      const url = await openMachine(machine.id);
      // Stay where we are unless it answers. /config goes all the way to the
      // machine; /auth/info is answered by the local proxy even when it's down.
      await requestAt(url, "/api/v1/config").catch(() => { throw new Error(`Can't reach ${machine.name}`); });
      close();
      setMachineApiBase(url);
    } catch (reason) {
      setFailure(message(reason));
    }
  };
  const signIn = async (machine: PairedMachine) => {
    close();
    setFailure(null);
    try {
      await refreshMachineSession(machine.id, await signInToMachine(machine.url ?? ""));
      refresh();
    } catch (reason) {
      setFailure(message(reason));
    }
  };
  const openRow = (machine: PairedMachine) => {
    if (machine.status === "needs_login" && isTauriShell) void signIn(machine);
    else if (machine.status === "signed_out" || machine.status === "needs_login") {
      close();
      setDialog({ mode: "connect", url: machine.url ?? "" });
    } else void switchTo(machine);
  };

  return (
    <div ref={rootRef} className="orbit-machine">
      {open ? (
        <div className="orbit-machine-pop" role="menu" aria-label="Machines">
          {ios ? ios.servers.map((server) => {
            const here = server.id === ios.current;
            const answer = here ? "grove" : reach[server.id];
            return (
              <MachineRow
                key={`ios-${server.id}`}
                machine={{ ...home, id: server.id, name: server.name, icon: here ? home.icon : "server" }}
                tone={answer === "grove" ? "ok" : answer === "sign_in" ? "warn" : "off"}
                note={`${answer === "none" ? "Can't reach · " : answer === "sign_in" ? "Sign in · " : ""}${iosServerHost(server.server)}`}
                current={here && atHome}
                disabled={here && atHome}
                onOpen={() => (here ? goHome() : switchServer(server))}
                onEdit={() => { close(); setIosDialog({ mode: "edit", server }); }}
              />
            );
          }) : (
            <MachineRow machine={home} tone="ok" note={homeNote(home)} current={current === home.id} disabled={current === home.id} onOpen={goHome} onEdit={() => { close(); setDialog({ mode: "edit", machine: home, isThis: true }); }} />
          )}
          {machines.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              tone={machine.status === "online" ? "ok" : machine.status === "offline" ? "off" : "warn"}
              note={machineNote(machine)}
              current={current === machine.id}
              disabled={current === machine.id || machine.status === "offline" || !machine.url}
              onOpen={() => openRow(machine)}
              onEdit={() => { close(); setDialog({ mode: "edit", machine, isThis: false }); }}
            />
          ))}
          {failure ? <p className="orbit-machine-error orbit-machine-failure" role="alert">{failure}</p> : null}
          <div className="orbit-machine-sep" />
          {ios ? (
            <button type="button" role="menuitem" className="orbit-machine-add" onClick={() => { close(); setIosDialog({ mode: "add" }); }}><Plus size={15} strokeWidth={1.7} /><span>Add a server</span></button>
          ) : (
            <button type="button" role="menuitem" className="orbit-machine-add" onClick={() => { close(); setDialog({ mode: "connect" }); }}><Plus size={15} strokeWidth={1.7} /><span>Connect a machine</span></button>
          )}
        </div>
      ) : null}
      <button type="button" className="orbit-row orbit-nav-row orbit-machine-entry" aria-haspopup="menu" aria-expanded={open} aria-label={`Machine: ${shown.name}`} onClick={toggle}>
        <MachineGlyph icon={shown.icon} />
        <span>{shown.name}</span>
        {shownStatus === "online" ? null : <StatusDot tone="warn" size="sm" label="Not connected" />}
        <ChevronsUpDown size={14} strokeWidth={1.6} className="orbit-machine-chevron" />
      </button>
      {dialog ? <MachineDialog state={dialog} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {iosDialog ? <IosServerDialog state={iosDialog} onClose={() => setIosDialog(null)} onChanged={refresh} /> : null}
    </div>
  );
}
