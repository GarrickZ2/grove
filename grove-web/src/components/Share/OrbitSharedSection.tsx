import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Link2, Trash2, WifiOff } from "lucide-react";
import { DropdownMenu } from "../ui/DropdownMenu";
import { listReceivedShares, removeReceivedShare, type ReceivedShare } from "../../api/shares";
import { hasNews, openShareLink, receivedStatus, sharedListChanged } from "./shareEvents";
import { initials } from "./shareFormat";
import "./share.css";

/** Sidebar "Shared with me": Tasks other people shared with this Grove. */
export function OrbitSharedSection({ activeItem, onOpen }: { activeItem: string; onOpen: (item: string) => void }) {
  const [shares, setShares] = useState<ReceivedShare[]>([]);
  const [expanded, setExpanded] = useState(true);

  const refresh = useCallback(() => {
    listReceivedShares().then((data) => setShares(data.shares)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 120_000);
    window.addEventListener("grove:shared-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("grove:shared-changed", refresh);
    };
  }, [refresh]);

  if (shares.length === 0) return null;
  return (
    <div className="orbit-section">
      <div className="orbit-task-section-heading">
        <button type="button" className="orbit-task-section-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span>Shared with me</span><ChevronDown size={13} className={expanded ? "" : "is-collapsed"} />
        </button>
        <div className="orbit-section-actions">
          <button
            type="button"
            className="orbit-section-add"
            title="Open the share link on the clipboard"
            aria-label="Open a share link"
            onClick={async () => {
              // Opens the link on the clipboard; ⌘K takes a pasted one too.
              const text = await navigator.clipboard?.readText?.().catch(() => "");
              openShareLink(text?.trim() || "");
            }}
          >
            <Link2 size={15} strokeWidth={1.7} />
          </button>
        </div>
      </div>
      {expanded && shares.map((share) => {
        const id = `shared:${share.id}`;
        const status = receivedStatus(share);
        const tag = status === "dead" ? "Ended" : !share.canComment ? "View only" : null;
        return (
          <div key={share.id} className="orbit-task">
            <div className="orbit-task-row">
              <button
                type="button"
                className={`orbit-task-toggle orbit-shared-row${activeItem === id ? " is-selected" : ""}${status === "dead" ? " is-dead" : ""}`}
                aria-current={activeItem === id ? "page" : undefined}
                title={`${share.owner} · ${share.title}`}
                onClick={() => onOpen(id)}
              >
                <span className="share-avatar">{initials(share.owner)}</span>
                <span className="orbit-shared-name">{share.title || "Shared task"}</span>
                {status === "offline" && <WifiOff size={12} aria-label={`${share.owner}'s Grove is offline`} />}
                {status === "live" && hasNews(share) && <span className="orbit-shared-dot" aria-label="New activity" />}
                {tag && <span className="orbit-shared-tag">{tag}</span>}
              </button>
              <div className="orbit-row-menu"><DropdownMenu portal compact appearance="orbit" placement="bottom" ariaLabel={`More actions for ${share.title}`} triggerClassName="orbit-more-button" items={[
                {
                  id: "remove",
                  label: "Remove",
                  icon: Trash2,
                  variant: "danger" as const,
                  onClick: () => {
                    void removeReceivedShare(share.id).then(() => {
                      sharedListChanged();
                      if (activeItem === id) onOpen("dashboard");
                    });
                  },
                },
              ]} /></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
