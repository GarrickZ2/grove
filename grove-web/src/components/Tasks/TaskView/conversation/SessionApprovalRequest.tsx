import { useEffect, useState } from "react";
import { decideApproval, getPendingApprovals, type Capability, type PendingApproval } from "../../../../api/browser";
import { OrbitPermissionRequest, type OrbitPermission } from "./OrbitPermissionCard";

const POLL_MS = 1500;

const OPTIONS: OrbitPermission["options"] = [
  { option_id: "allow", name: "Allow", kind: "allow_once" },
  { option_id: "decline", name: "Decline", kind: "reject_once" },
];

const REQUESTS: Record<Capability, OrbitPermission> = {
  personal_browser: {
    id: "personal-browser-approval",
    description: "Use your browser?",
    detail: "For this session, the agent could open any site with your logins and act as you there.",
    options: OPTIONS,
  },
  computer: {
    id: "computer-approval",
    description: "Use your computer?",
    detail: "For this session, the agent could see your screen and operate any app on this computer, as you can.",
    options: OPTIONS,
  },
};

/** This chat Session waiting to use the user's browser or computer, asked in its own chat. */
export function SessionApprovalRequest({ projectId, taskId, chatId }: { projectId: string; taskId: string; chatId: string | null }) {
  const [pending, setPending] = useState<PendingApproval[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void getPendingApprovals(projectId, taskId)
        .then((next) => { if (alive) setPending(next); })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [projectId, taskId]);

  const request = pending.find((item) => item.chatId === chatId);
  if (!request) return null;
  return (
    <div className="oc-ask">
      <OrbitPermissionRequest
        key={request.capability}
        message={REQUESTS[request.capability]}
        onRespond={(optionId) => {
          void decideApproval(projectId, taskId, { ...request, allow: optionId === "allow" })
            .then(setPending)
            .catch(() => {});
        }}
      />
    </div>
  );
}
