import { AlertTriangle, ChevronRight, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "../../ui";
import { XTerminal } from "../TaskDetail/XTerminal";

export interface AuthMethodOption {
  type?: "agent" | "terminal";
  id: string;
  name: string;
  description?: string;
}

export interface AuthRequiredState {
  methods: AuthMethodOption[];
  agentName?: string | null;
  status: "idle" | "in_progress" | "succeeded" | "failed";
  activeMethodId?: string;
  errorMessage?: string;
}

/** AuthRequired panel — 渲染在 composerPanel 区域(对齐 PermissionRequest)。
 * 暗色 tertiary 背景、warning 左强调条、标题 + 描述 + ghost 风格选项按钮。
 * in_progress / succeeded 期间整组按钮 disable;每个 method 单独一行,
 * 含可选 description 二行注释。 */
export function AuthRequiredPanel({
  message,
  index,
  agentLabel,
  onAuthLogin,
  onAuthRetry,
  projectId,
  taskId,
  chatId,
  onTerminalEnd,
}: {
  message: AuthRequiredState;
  index: number;
  agentLabel?: string;
  onAuthLogin?: (index: number, methodId: string) => void;
  onAuthRetry?: (index: number) => void;
  projectId: string;
  taskId: string;
  chatId?: string;
  onTerminalEnd: (index: number, error?: string) => void;
}) {
  const agentDisplay = message.agentName || agentLabel || "Agent";
  const hasMethods = message.methods.length > 0;
  const activeMethod = message.activeMethodId
    ? message.methods.find((m) => m.id === message.activeMethodId)
    : undefined;
  const terminalLogin = activeMethod?.type === "terminal" && message.status === "in_progress" && chatId;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const terminalUrl = terminalLogin
    ? `${protocol}//${window.location.host}/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/chats/${encodeURIComponent(chatId)}/auth-terminal/${encodeURIComponent(activeMethod.id)}`
    : undefined;
  let title: string;
  let description: string;
  if (message.status === "succeeded") {
    title = "Login successful";
    description = "Retrying your request...";
  } else if (message.status === "in_progress") {
    title = "Authenticating";
    description = activeMethod
      ? `Complete the ${activeMethod.name} sign-in flow. The session will resume automatically once finished.`
      : "Checking whether the external sign-in completed...";
  } else if (message.status === "failed") {
    title = "Login failed";
    description =
      message.errorMessage ?? "Please choose an option below to try again.";
  } else if (!hasMethods) {
    title = "Authentication required";
    description = `${agentDisplay} did not advertise a login method. Sign in with the agent's CLI, then retry the request.`;
  } else {
    title = "Authentication required";
    description = `${agentDisplay} needs you to sign in before continuing. Pick a login method below.`;
  }
  const buttonsDisabled =
    message.status === "in_progress" || message.status === "succeeded";

  return (
    <div className="space-y-3 relative">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)] mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {title}
          </div>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)] break-all whitespace-pre-wrap leading-relaxed">
            {description}
          </p>
        </div>
      </div>
      {terminalUrl && (
        <div className="space-y-2">
          <div className="h-72 overflow-hidden rounded-lg border border-[var(--color-border)]">
            <XTerminal
              wsUrl={terminalUrl}
              onConnectionError={() => onTerminalEnd(index, "Could not open the sign-in terminal. Please retry.")}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => onTerminalEnd(index)}>
            Cancel sign-in
          </Button>
        </div>
      )}
      {hasMethods && (
        <div className="space-y-2">
          {message.methods.map((method) => {
            const isActive = method.id === message.activeMethodId;
            const showSpinner = isActive && message.status === "in_progress";
            const showCheck = isActive && message.status === "succeeded";
            return (
              <button
                key={method.id}
                type="button"
                disabled={buttonsDisabled}
                onClick={() => onAuthLogin?.(index, method.id)}
                className="flex w-full items-center justify-between rounded-xl border border-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_7%,transparent)] px-3 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[color-mix(in_srgb,var(--color-warning)_7%,transparent)]"
              >
                <span className="flex-1 min-w-0 pr-2">
                  <span className="block text-sm font-medium text-[var(--color-text)]">
                    {method.name}
                  </span>
                  {method.description && (
                    <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)] leading-snug">
                      {method.description}
                    </span>
                  )}
                </span>
                {showCheck ? (
                  <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--color-success)]" />
                ) : showSpinner ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--color-warning)]" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-warning)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
      {!hasMethods && (
        <button
          type="button"
          disabled={buttonsDisabled}
          onClick={() => onAuthRetry?.(index)}
          className="flex w-full items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_7%,transparent)] px-3 py-2.5 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {message.status === "in_progress" ? "Retrying..." : "Retry"}
        </button>
      )}
    </div>
  );
}

