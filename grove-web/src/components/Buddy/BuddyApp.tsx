import { useCallback, useRef, useState } from "react";
import { ChevronLeft, Settings, X } from "lucide-react";
import { TabletAsDesktopContext, useIsMobile } from "../../hooks/useIsMobile";
import { useBuddyBackSwipe } from "../../hooks/useBuddyBackSwipe";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { useBuddies } from "../../hooks/useBuddies";
import { useRadioEvents } from "../../hooks/useRadioEvents";
import { BUDDIES_MOCK_ENABLED } from "../../api/buddies.mock";
import { SettingsPage } from "../Config/SettingsPage";
import { DialogShell } from "../ui/DialogShell";
import { errorMessage } from "../../utils/errorMessage";
import { BuddySidebar } from "./BuddySidebar";
import { BuddyOnboarding } from "./BuddyOnboarding";
import { BuddySwitcher } from "./BuddySwitcher";
import type { BuddyTemplate } from "./buddyTemplates";
import { CreateBuddyDialog } from "./CreateBuddyDialog";
import { BuddyConversation } from "./BuddyConversation";
import { BuddyConversationHeader } from "./BuddyConversationHeader";
import { readBuddyPreference, writeBuddyPreference } from "./buddyStorage";
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
  const device = useIsMobile();
  const phone = device.isMobile && !device.isTablet;
  const hasMacControls = ("__TAURI__" in window || "__TAURI_INTERNALS__" in window) && /Mac/i.test(navigator.platform);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const back = useCallback(() => { setConversationOpen(false); setSheetOpen(false); }, []);
  const [creating, setCreating] = useState(!!request?.create);
  const [handledRequest, setHandledRequest] = useState(request);
  if (request !== handledRequest) {
    setHandledRequest(request);
    if (request?.id) { data.select(request.id); setConversationOpen(true); }
    if (request?.create) setCreating(true);
  }
  const [template, setTemplate] = useState<BuddyTemplate>();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const createFrom = (value?: BuddyTemplate) => { setTemplate(value); setTemplatesOpen(false); setCreating(true); };
  const [settings, setSettings] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => readBuddyPreference("panel-open", "false") === "true");
  const [panelTab, setPanelTab] = useState<BuddyPanelTab>("routines");
  const shownPanel = phone ? sheetOpen : panelOpen;
  const select = (id: string) => { data.select(id); setConversationOpen(true); };
  const openSettings = (id: string) => {
    select(id); setPanelTab("settings");
    if (phone) setSheetOpen(true);
    else { setPanelOpen(true); writeBuddyPreference("panel-open", "true"); }
  };
  const togglePanel = () => {
    if (phone) setSheetOpen(!sheetOpen);
    else { setPanelOpen(!panelOpen); writeBuddyPreference("panel-open", String(!panelOpen)); }
  };
  useBuddyBackSwipe({ enabled: phone && conversationOpen && !sheetOpen && !creating && !settings && !archiveId, pageRef, onBack: back });
  useEscapeScope(settings, () => setSettings(false));
  useEscapeScope(phone && sheetOpen && !archiveId, () => setSheetOpen(false));
  useEscapeScope(archiveId !== null && !archiving, () => setArchiveId(null));
  const archive = async () => {
    if (!archiveId || archiving) return;
    setArchiving(true);
    try { await data.archive(archiveId); setArchiveId(null); if (archiveId === data.selectedId) back(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setArchiving(false); }
  };
  const exit = <button type="button" className="buddy-exit" aria-label="Back to Grove" title="Back to Grove" onClick={onExit}><ChevronLeft size={16} />Grove</button>;
  const single = data.items.length === 1;
  const empty = !data.loading && data.items.length === 0;
  const showConversation = conversationOpen || single;
  return <TabletAsDesktopContext.Provider value={true}><div className={`buddy-app${hasMacControls ? " has-mac-controls" : ""}${phone ? " is-phone" : ""}${showConversation || empty ? " is-conversation-open" : ""}${single ? " is-single" : ""}`}>
    {!BUDDIES_MOCK_ENABLED && <BuddyEvents data={data} />}
    {data.items.length >= 2 && <BuddySidebar exit={exit} loading={data.loading} error={phone && !conversationOpen ? error || data.error : null} onRetry={() => { setError(null); void data.refresh(); }} items={data.items} selectedId={data.selectedId} phone={phone} onSelect={select} onCreate={() => createFrom()} onGlobalSettings={() => setSettings(true)} onBuddySettings={openSettings} onArchive={setArchiveId} onReorder={(ids) => { void data.reorder(ids).catch((reason) => setError(errorMessage(reason))); }} />}
    <main ref={pageRef} className="buddy-main">{(error || data.error) && <div role="alert">{error || data.error}<button type="button" onClick={() => { setError(null); void data.refresh(); }}>Retry</button></div>}
      {empty ? <><header className="buddy-zero-header" data-tauri-drag-region="deep" data-window-drag-strip>{exit}<button type="button" className="orbit-icon-button" aria-label="Grove settings" onClick={() => setSettings(true)}><Settings size={18} /></button></header><BuddyOnboarding onCreate={createFrom} /></> : data.buddy ? <><BuddyConversationHeader buddy={data.buddy} leading={single ? exit : undefined} switcher={single ? <BuddySwitcher buddy={data.buddy} onCreate={() => createFrom()} onTemplates={() => setTemplatesOpen(true)} /> : undefined} phone={phone && !single} onBack={back} panelOpen={shownPanel} onSettings={() => openSettings(data.selectedId)} onPanel={togglePanel} /><BuddyConversation key={`${data.buddy.id}-${data.buddy.active_session_id}`} buddy={data.buddy} onChanged={() => { void data.refreshItem(data.selectedId); }} /></> : <div className="buddy-empty"><h2>{data.loading ? "Loading Buddies…" : "Choose a Buddy"}</h2></div>}
    </main>
    {!phone && panelOpen && data.buddy && <BuddySidePanel buddy={data.buddy} tab={panelTab} onTab={setPanelTab} onChanged={data.accept} onArchive={() => setArchiveId(data.selectedId)} onClose={togglePanel} />}
    {phone && <DialogShell isOpen={sheetOpen && !!data.buddy} onClose={() => setSheetOpen(false)} swipeToClose><div className="buddy-sheet">{data.buddy && <BuddySidePanel buddy={data.buddy} tab={panelTab} onTab={setPanelTab} onChanged={data.accept} onArchive={() => setArchiveId(data.selectedId)} onClose={() => setSheetOpen(false)} />}</div></DialogShell>}
    {templatesOpen && <DialogShell isOpen onClose={() => setTemplatesOpen(false)} maxWidth="max-w-[800px]"><div className="buddy-dialog"><button type="button" className="orbit-icon-button" aria-label="Close templates" onClick={() => setTemplatesOpen(false)}><X /></button><BuddyOnboarding onCreate={createFrom} /></div></DialogShell>}
    {creating && <CreateBuddyDialog template={template} onClose={() => setCreating(false)} onCreate={async (input) => { const buddy = await data.create(input); setConversationOpen(true); return buddy; }} />}
    {settings && <div className="buddy-global-settings" role="dialog" aria-modal="true" aria-label="Grove settings"><button type="button" className="buddy-icon-button buddy-global-close" aria-label="Close Grove settings" onClick={() => setSettings(false)}><X /></button><SettingsPage /></div>}
    <DialogShell isOpen={archiveId !== null} onClose={() => { if (!archiving) setArchiveId(null); }}><div className="buddy-dialog"><h2>Archive Buddy?</h2><p>Your data and conversation history are kept. Routines and IM connections will not stop automatically.</p>{error && <p role="alert">{error}</p>}<div className="buddy-actions"><button type="button" className="buddy-button" disabled={archiving} onClick={() => setArchiveId(null)}>Cancel</button><button type="button" className="buddy-button is-danger" disabled={archiving} onClick={() => void archive()}>Archive Buddy</button></div></div></DialogShell>
  </div></TabletAsDesktopContext.Provider>;
}
