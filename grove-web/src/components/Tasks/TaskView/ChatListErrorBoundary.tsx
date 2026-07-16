import { Component, type ErrorInfo, type ReactNode } from "react";

interface ChatListErrorBoundaryProps {
  children: ReactNode;
  resetKey: string | null;
  projectId: string;
  taskId: string;
}

interface ChatListErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a virtualized chat-list failure scoped to the message viewport.
 * Switching chats or pressing Retry mounts a fresh Virtuoso instance.
 */
export class ChatListErrorBoundary extends Component<
  ChatListErrorBoundaryProps,
  ChatListErrorBoundaryState
> {
  state: ChatListErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ChatListErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ChatListErrorBoundary] chat list crashed", {
      error,
      componentStack: info.componentStack,
      projectId: this.props.projectId,
      taskId: this.props.taskId,
      chatId: this.props.resetKey,
    });
  }

  componentDidUpdate(prevProps: ChatListErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private retry = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center px-6"
        role="alert"
      >
        <div className="max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-center shadow-sm">
          <div className="text-sm font-medium text-[var(--color-text)]">
            Chat list stopped unexpectedly
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
            The rest of Grove is still available. Retry to rebuild this chat's
            message list.
          </p>
          <button
            type="button"
            onClick={this.retry}
            className="mt-4 rounded-lg bg-[var(--color-highlight)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Retry chat list
          </button>
        </div>
      </div>
    );
  }
}
