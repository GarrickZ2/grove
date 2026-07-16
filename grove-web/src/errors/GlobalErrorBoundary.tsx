import { Component, type ErrorInfo, type ReactNode } from "react";

import {
  createClientErrorReport,
  formatClientErrorReport,
  reportClientError,
  type ClientErrorReport,
} from "./clientErrorReport";

interface GlobalErrorBoundaryProps {
  children: ReactNode;
}

interface GlobalErrorBoundaryState {
  error: Error | null;
  report: ClientErrorReport | null;
  copied: boolean;
}

export class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = {
    error: null,
    report: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<GlobalErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = reportClientError(error, {
      source: "react-caught",
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({ report });
  }

  private reload = () => {
    window.location.reload();
  };

  private copyDiagnostics = async () => {
    const report = this.getReport();
    const text = formatClientErrorReport(report);
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
    } catch (error) {
      console.warn("[GlobalErrorBoundary] failed to copy diagnostics", error);
      this.setState({ copied: false });
    }
  };

  private getReport(): ClientErrorReport {
    return (
      this.state.report ??
      createClientErrorReport(this.state.error, { source: "react-caught" })
    );
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const diagnostics = formatClientErrorReport(this.getReport());
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-6 py-10 text-[var(--color-text)]">
        <section className="w-full max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-xl">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-error)]">
            Grove stopped unexpectedly
          </div>
          <h1 className="mt-2 text-xl font-semibold">Reload Grove to continue</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
            The current interface could not recover safely. Copy the diagnostics
            for a developer, then reload the application.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="rounded-lg bg-[var(--color-highlight)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Reload Grove
            </button>
            <button
              type="button"
              onClick={() => void this.copyDiagnostics()}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
            >
              {this.state.copied ? "Diagnostics copied" : "Copy diagnostics"}
            </button>
          </div>

          <details className="mt-5">
            <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">
              Show crash details
            </summary>
            <textarea
              readOnly
              value={diagnostics}
              aria-label="Crash diagnostics"
              className="mt-3 h-56 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-5 text-[var(--color-text-muted)] outline-none"
              onFocus={(event) => event.currentTarget.select()}
            />
          </details>
        </section>
      </main>
    );
  }
}
