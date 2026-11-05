import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { TabletAsDesktopContext, useIsMobile } from "../../hooks/useIsMobile";
import { useBuddyBackSwipe } from "../../hooks/useBuddyBackSwipe";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { useBuddies } from "../../hooks/useBuddies";
import { useBuddyDelegations, useDelegationRequests } from "../../hooks/useBuddyDelegations";
import { useBuddyGroups } from "../../hooks/useBuddyGroups";
import { useBuddyUnread } from "../../hooks/useBuddyUnread";
import { BuddyDelegationsContext } from "./delegations/buddyDelegationsContext";
import { useRadioEvents } from "../../hooks/useRadioEvents";
import { BUDDIES_MOCK_ENABLED } from "../../api/buddies.mock";
import { DialogShell } from "../ui/DialogShell";
import { errorMessage } from "../../utils/errorMessage";
import { BuddySidebar } from "./BuddySidebar";
import { BuddyOnboarding } from "./BuddyOnboarding";
import { BuddySwitcher } from "./BuddySwitcher";
import type { BuddyTemplate } from "./buddyTemplates";
import { CreateBuddyDialog } from "./CreateBuddyDialog";
import { createBuddyAt } from "../../api/buddies";
import { getHomeApiBase } from "../../api/client";
import { BuddyConversation } from "./BuddyConversation";
import { BuddyConversationHeader } from "./BuddyConversationHeader";
import { createBuddyGroup, createBuddyGroupAt, disbandBuddyGroup, GROUP_REF_PREFIX, mergeBuddyList, pinBuddyGroup } from "../../api/buddyGroups";
import { BuddyGroupConversation, BuddyGroupHeader } from "./group/BuddyGroupConversation";
import { BuddyGroupPanel } from "./group/BuddyGroupPanel";
import { CreateBuddyGroupDialog } from "./group/CreateBuddyGroupDialog";
import { readBuddyPreference, writeBuddyPreference } from "./buddyStorage";
import { useMachineBuddies, type MachineBuddies } from "./useMachineBuddies";
import { BuddySidePanel, type BuddyPanelTab } from "./BuddySidePanel/BuddySidePanel";
import "./buddy.css";

function BuddyEvents({ data }: { data: ReturnType<typeof useBuddies> }) {
  useRadioEvents({
    onConnected: () => { void data.refresh(); },
    onChatStatus: (_project, _task, chat) => { const buddy = data.items.find((item) => item.active_session_id === chat); if (buddy) void data.refreshItem(buddy.id); },
    onPromptSent: () => { if (data.selectedId) void data.refreshItem(data.selectedId); },
  });
  return null;
}

export function BuddyApp({ onExit = () => {}, request }: { onExit?: () => void; request?: { id?: string; create?: boolean; revision: number } }) {
  const data = useBuddies();
  const groups = useBuddyGroups();
  const [groupId, setGroupId] = useState(() => readBuddyPreference("selected-group"));
  const group = groups.items.find((item) => item.id === groupId) ?? null;
  const showGroup = (id: string) => { setGroupId(id); writeBuddyPreference("selected-group", id); };
  const [order, setOrder] = useState<string[] | null>(null);
  const listed = mergeBuddyList(data.items, groups.items, order);
  const { sections: machines, openOn } = useMachineBuddies(listed);
  const device = useIsMobile();
  const phone = device.isMobile && !device.isTablet;
  const hasMacControls = ("__TAURI__" in window || "__TAURI_INTERNALS__" in window) && /Mac/i.test(navigator.platform);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const back = () => { setConversationOpen(false); setSheetOpen(false); };
  const [creating, setCreating] = useState(!!request?.create);
  const [creatingOn, setCreatingOn] = useState<MachineBuddies | null>(null);
  const [groupingOn, setGroupingOn] = useState<MachineBuddies | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [disbandId, setDisbandId] = useState<string | null>(null);
  const [disbanding, setDisbanding] = useState(false);
  const [handledRequest, setHandledRequest] = useState(request);
  if (request !== handledRequest) {
    setHandledRequest(request);
    if (request?.id?.startsWith(GROUP_REF_PREFIX)) { showGroup(request.id.slice(GROUP_REF_PREFIX.length)); setConversationOpen(true); }
    else if (request?.id) { showGroup(""); data.select(request.id); setConversationOpen(true); }
    if (request?.create) setCreating(true);
  }
  const [template, setTemplate] = useState<BuddyTemplate>();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const createFrom = (value?: BuddyTemplate) => { setTemplate(value); setTemplatesOpen(false); setCreating(true); };
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const [panelOpen, setPanelOpen] = useState(() => readBuddyPreference("panel-open", "false") === "true");
  const [panelTab, setPanelTab] = useState<BuddyPanelTab>("delegations");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readBuddyPreference("sidebar-collapsed", "false") === "true");
  const toggleSidebar = () => { setSidebarCollapsed(!sidebarCollapsed); writeBuddyPreference("sidebar-collapsed", String(!sidebarCollapsed)); };
  const [focusedDelegation, setFocusedDelegation] = useState<string | null>(null);
  const shownPanel = phone ? sheetOpen : panelOpen;
  // Only the Buddy just created plays its arrival; any other selection ends it.
  const [arrivedId, setArrivedId] = useState<string | null>(null);
  const [arrivedGroupId, setArrivedGroupId] = useState<string | null>(null);
  const isGroup = (id: string) => groups.items.some((item) => item.id === id);
  const select = (id: string) => {
    setConversationOpen(true);
    if (id !== arrivedGroupId) setArrivedGroupId(null);
    if (isGroup(id)) { showGroup(id); return; }
    showGroup(""); data.select(id); if (id !== arrivedId) setArrivedId(null);
  };
  const showPanel = (tab: BuddyPanelTab) => {
    setPanelTab(tab);
    if (phone) setSheetOpen(true);
    else { setPanelOpen(true); writeBuddyPreference("panel-open", "true"); }
  };
  const openSettings = (id: string) => { select(id); showPanel("settings"); };
  const groupsChanged = () => { void groups.refresh(); };
  const delegations = useBuddyDelegations(data.buddy);
  const requests = useDelegationRequests(delegations.items);
  const delegationContext = { ...delegations, requests, focused: focusedDelegation, show: (id: string) => { setFocusedDelegation(id); showPanel("delegations"); } };
  const togglePanel = () => {
    if (phone) setSheetOpen(!sheetOpen);
    else { setPanelOpen(!panelOpen); writeBuddyPreference("panel-open", String(!panelOpen)); }
  };
  useBuddyBackSwipe({ enabled: phone && conversationOpen && !sheetOpen && !creating && !creatingGroup && !archiveId && !deleteId && !disbandId, pageRef, onBack: back });
  useEscapeScope(phone && sheetOpen && !archiveId, () => setSheetOpen(false));
  useEscapeScope(archiveId !== null && !archiving, () => setArchiveId(null));
  useEscapeScope(deleteId !== null && !removing, () => setDeleteId(null));
  useEscapeScope(disbandId !== null && !disbanding, () => setDisbandId(null));
  const archive = async () => {
    if (!archiveId || archiving) return;
    setArchiving(true);
    try { await data.archive(archiveId); setArchiveId(null); if (archiveId === data.selectedId) back(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setArchiving(false); }
  };
  const exit = <button type="button" className="buddy-exit" aria-label="Back to Grove" title="Back to Grove" onClick={onExit}><ChevronLeft size={16} />Grove</button>;
  const multiMachine = machines.length > 0;
  const hasList = listed.length >= 2 || multiMachine;
  const single = listed.length === 1 && !multiMachine;
  const selectedId = group?.id ?? data.selectedId;
  // Phones navigate between list and conversation instead of collapsing.
  // Collapse only while a conversation header can offer the way back.
  const collapsed = hasList && !phone && sidebarCollapsed && !!(data.buddy || group);
  const listShown = hasList && !collapsed;
  const sidebarToggle = (open: boolean) => <button type="button" className="orbit-icon-button buddy-icon-button" title={open ? "Collapse sidebar" : "Expand sidebar"} aria-label={open ? "Collapse sidebar" : "Expand sidebar"} aria-expanded={open} onClick={toggleSidebar}>{open ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>;
  const empty = !data.loading && data.items.length === 0;
  const showConversation = conversationOpen || single;
  // Desktop always shows the selected conversation; phones only once it is opened.
  const viewingId = !phone || showConversation ? selectedId : "";
  const { unread, markRead, markUnread } = useBuddyUnread(listed, viewingId);
  const deleting = data.items.find((item) => item.id === deleteId);
  const remove = async () => {
    if (!deleteId || removing) return;
    setRemoving(true);
    try { await data.remove(deleteId); setDeleteId(null); if (deleteId === data.selectedId) back(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setRemoving(false); }
  };
  const pin = (id: string, pinned: boolean) => {
    if (isGroup(id)) { void pinBuddyGroup(id, pinned).then(groupsChanged).catch((reason) => setError(errorMessage(reason))); return; }
    void data.pin(id, pinned).catch((reason) => setError(errorMessage(reason)));
  };
  const disband = async () => {
    if (!disbandId || disbanding) return;
    setDisbanding(true);
    try { await disbandBuddyGroup(disbandId); await groups.refresh(); setDisbandId(null); if (disbandId === group?.id) { showGroup(""); back(); } }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setDisbanding(false); }
  };
  const disbandingName = groups.items.find((item) => item.id === disbandId)?.name ?? "group";
  const groupPanel = (closable: boolean, close: () => void) => group && <BuddyGroupPanel group={group} buddies={data.items} closable={closable} onChanged={groupsChanged} onDisband={() => setDisbandId(group.id)} onOpenBuddy={select} onClose={close} />;
  return <TabletAsDesktopContext.Provider value={true}><BuddyDelegationsContext.Provider value={delegationContext}><div className={`buddy-app${hasMacControls ? " has-mac-controls" : ""}${phone ? " is-phone" : ""}${showConversation || empty ? " is-conversation-open" : ""}${single ? " is-single" : ""}${collapsed ? " is-sidebar-collapsed" : ""}`}>
    {!BUDDIES_MOCK_ENABLED && <BuddyEvents data={data} />}
    {listShown && <BuddySidebar machines={multiMachine ? machines : undefined} onOpenMachine={openOn} onCreateOnMachine={(section, kind) => (kind === "group" ? setGroupingOn : setCreatingOn)(section)} exit={exit} toggle={phone ? undefined : sidebarToggle(true)} loading={data.loading} error={phone && !conversationOpen ? error || data.error : null} onRetry={() => { setError(null); void data.refresh(); }} items={listed} unread={unread} selectedId={selectedId} viewingId={viewingId} phone={phone} onSelect={select} onCreate={() => createFrom()} onCreateGroup={data.items.length >= 2 ? () => setCreatingGroup(true) : undefined} onBuddySettings={openSettings} onDelete={(id) => { setError(null); if (isGroup(id)) setDisbandId(id); else setDeleteId(id); }} onPin={pin} onMarkRead={markRead} onMarkUnread={markUnread} onReorder={(ids) => { setOrder(ids); void data.reorder(ids).then(groupsChanged).catch((reason) => { setOrder(null); setError(errorMessage(reason)); }); }} />}
    <main ref={pageRef} className="buddy-main">{(error || data.error) && <div role="alert">{error || data.error}<button type="button" onClick={() => { setError(null); void data.refresh(); }}>Retry</button></div>}
      {empty ? <div className="buddy-zero"><div className="buddy-zero-backdrop" aria-hidden="true"><span /><span /><span /></div><header className="buddy-zero-header" data-tauri-drag-region="deep" data-window-drag-strip>{listShown ? null : exit}</header><BuddyOnboarding onCreate={createFrom} /></div> : group ? <><BuddyGroupHeader group={group} leading={collapsed ? <>{exit}{sidebarToggle(false)}</> : undefined} phone={phone} onBack={back} panelOpen={shownPanel} onPanel={togglePanel} /><BuddyGroupConversation key={group.id} group={group} buddies={data.items} onChanged={groupsChanged} arriving={group.id === arrivedGroupId} /></> : data.buddy ? <><BuddyConversationHeader buddy={data.buddy} leading={single ? exit : collapsed ? <>{exit}{sidebarToggle(false)}</> : undefined} switcher={single ? <BuddySwitcher buddy={data.buddy} onCreate={() => createFrom()} onTemplates={() => setTemplatesOpen(true)} /> : undefined} phone={phone && !single} onBack={back} panelOpen={shownPanel} onPanel={togglePanel} /><BuddyConversation key={`${data.buddy.id}-${data.buddy.active_session_id}`} buddy={data.buddy} others={data.items.filter((item) => item.id !== data.buddy?.id)} arriving={data.buddy.id === arrivedId} onChanged={() => { void data.refreshItem(data.selectedId); }} /></> : <div className="buddy-empty"><h2>{data.loading ? "Loading Buddies…" : "Choose a Buddy"}</h2></div>}
    </main>
    {/* The shell animates its width so the conversation eases aside while the panel slides in from the right. */}
    <AnimatePresence initial={false}>{!phone && panelOpen && (group || data.buddy) && <motion.div key="buddy-side-panel" className="buddy-side-panel-shell" initial={{ width: 0 }} animate={{ width: "auto" }} exit={{ width: 0 }} transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.2, 0.7, 0.3, 1] }}>{group ? groupPanel(false, togglePanel) : data.buddy && <BuddySidePanel buddy={data.buddy} tab={panelTab} onTab={setPanelTab} onChanged={data.accept} onArchive={() => setArchiveId(data.selectedId)} onClose={togglePanel} />}</motion.div>}</AnimatePresence>
    {phone && <DialogShell isOpen={sheetOpen && !!(group || data.buddy)} onClose={() => setSheetOpen(false)} swipeToClose><div className="buddy-sheet">{group ? groupPanel(true, () => setSheetOpen(false)) : data.buddy && <BuddySidePanel buddy={data.buddy} tab={panelTab} onTab={setPanelTab} onChanged={data.accept} onArchive={() => setArchiveId(data.selectedId)} onClose={() => setSheetOpen(false)} closable />}</div></DialogShell>}
    {templatesOpen && <DialogShell isOpen onClose={() => setTemplatesOpen(false)} maxWidth="max-w-[800px]"><div className="buddy-dialog"><button type="button" className="orbit-icon-button" aria-label="Close templates" onClick={() => setTemplatesOpen(false)}><X /></button><BuddyOnboarding onCreate={createFrom} /></div></DialogShell>}
    {creatingGroup && <CreateBuddyGroupDialog buddies={data.items} onClose={() => setCreatingGroup(false)} onCreate={async (input) => { const created = await createBuddyGroup(input); await groups.refresh(); setArrivedGroupId(created.id); showGroup(created.id); setConversationOpen(true); }} />}
    <DialogShell isOpen={disbandId !== null} onClose={() => { if (!disbanding) setDisbandId(null); }}><div className="buddy-dialog" role="alertdialog" aria-label={`Disband ${disbandingName}`}><h2>Disband {disbandingName}?</h2><p>The conversation ends for everyone. Each Buddy keeps its history and Memory in its own Project.</p><div className="buddy-actions"><button type="button" className="buddy-button" disabled={disbanding} onClick={() => setDisbandId(null)}>Cancel</button><button type="button" className="buddy-button is-danger" disabled={disbanding} onClick={() => void disband()}>{disbanding ? "Disbanding…" : "Disband"}</button></div></div></DialogShell>
    {groupingOn && <CreateBuddyGroupDialog buddies={(groupingOn.buddies ?? []).filter((entry) => !entry.group)} onClose={() => setGroupingOn(null)} onCreate={async (input) => {
      const created = await createBuddyGroupAt(groupingOn.base ?? getHomeApiBase(), input);
      openOn(groupingOn, { groupId: created.id });
    }} />}
    {creatingOn && <CreateBuddyDialog machine={{ name: creatingOn.machine.name, base: creatingOn.base ?? getHomeApiBase() }} onClose={() => setCreatingOn(null)} onCreate={async (input) => {
      const buddy = await createBuddyAt(creatingOn.base ?? getHomeApiBase(), input);
      openOn(creatingOn, { buddyId: buddy.id });
      return buddy;
    }} />}
    {creating && <CreateBuddyDialog template={template} onClose={() => setCreating(false)} onCreate={async (input) => { const buddy = await data.create(input); setArrivedId(buddy.id); setConversationOpen(true); return buddy; }} />}
    <DialogShell isOpen={deleteId !== null} onClose={() => { if (!removing) setDeleteId(null); }}><div className="buddy-dialog" role="alertdialog" aria-label={`Delete ${deleting?.name ?? "Buddy"}`}><h2>Delete {deleting?.name ?? "this Buddy"}?</h2><p>It leaves your Buddies and its Routines stop. Its conversations and memory stay on this computer.</p>{error && <p role="alert">{error}</p>}<div className="buddy-actions"><button type="button" className="buddy-button" disabled={removing} onClick={() => setDeleteId(null)}>Cancel</button><button type="button" className="buddy-button is-danger" disabled={removing} onClick={() => void remove()}>Delete</button></div></div></DialogShell>
    <DialogShell isOpen={archiveId !== null} onClose={() => { if (!archiving) setArchiveId(null); }}><div className="buddy-dialog"><h2>Archive Buddy?</h2><p>Your data and conversation history are kept. Routines and IM connections will not stop automatically.</p>{error && <p role="alert">{error}</p>}<div className="buddy-actions"><button type="button" className="buddy-button" disabled={archiving} onClick={() => setArchiveId(null)}>Cancel</button><button type="button" className="buddy-button is-danger" disabled={archiving} onClick={() => void archive()}>Archive Buddy</button></div></div></DialogShell>
  </div></BuddyDelegationsContext.Provider></TabletAsDesktopContext.Provider>;
}
