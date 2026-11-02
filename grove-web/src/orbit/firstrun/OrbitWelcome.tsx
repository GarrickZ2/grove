import { createElement, useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { Check, FolderOpen, FolderPlus, GitBranch, Palette, RotateCw, type LucideIcon } from "lucide-react";
import { getVersion } from "../../api";
import { MarketplaceModal } from "../../components/Config/MarketplaceModal";
import { GroveIcon } from "../../components/Layout/GroveIcon";
import type { WelcomeAction } from "../../components/Welcome/WelcomePage";
import { agentIconComponent } from "../../utils/agentIcon";
import { useDetectedAgents, type AgentDetection } from "./useDetectedAgents";
import "../tokens.css";
import "../ui/orbit-ui.css";
import "./welcome.css";

const ACTIONS: { id: WelcomeAction; icon: LucideIcon; title: string; description: string; tint: string; glow: string }[] = [
  { id: "existing", icon: FolderOpen, title: "Open a folder", description: "A repository already on this computer.", tint: "linear-gradient(150deg,#6ee7b7,#047857)", glow: "rgb(4 120 87 / 60%)" },
  { id: "git", icon: GitBranch, title: "Clone a repository", description: "Paste a Git URL and start working.", tint: "linear-gradient(150deg,#93c5fd,#1d4ed8)", glow: "rgb(29 78 216 / 55%)" },
  { id: "new", icon: FolderPlus, title: "Create a project", description: "Start from an empty folder.", tint: "linear-gradient(150deg,#fcd34d,#b45309)", glow: "rgb(180 83 9 / 55%)" },
  { id: "studio", icon: Palette, title: "Start a Studio", description: "For design, docs and assets. No Git needed.", tint: "linear-gradient(150deg,#f9a8d4,#be185d)", glow: "rgb(190 24 93 / 55%)" },
];

/** Agent chips shown before the rest fold into "+N". */
const CHIP_LIMIT = 4;

function AgentLine({ detection, checking, onRecheck, onInstall }: {
  detection: AgentDetection;
  checking: boolean;
  onRecheck: () => void;
  onInstall: () => void;
}) {
  if (detection.status === "loading") {
    return (
      <div className="owl-agents" aria-live="polite">
        <span>Looking for coding agents</span>
        <span className="owl-ag is-scan"><i />Looking…</span>
      </div>
    );
  }
  if (detection.status === "error") {
    return (
      <div className="owl-agents" aria-live="polite">
        <span>Couldn’t check which agents are installed.</span>
        <button type="button" className="owl-link" onClick={onRecheck} disabled={checking}>
          <RotateCw size={12} className={checking ? "owl-spin" : undefined} aria-hidden="true" />Check again
        </button>
      </div>
    );
  }
  const { agents } = detection;
  if (agents.length === 0) {
    return (
      <div className="owl-noag" aria-live="polite">
        <b>Grove needs a coding agent</b>
        <span>None found on this computer. Install one and Grove picks it up automatically.</span>
        <div className="owl-noag-row">
          <button type="button" className="oui-btn oui-btn-primary" onClick={onInstall}>Browse agents</button>
          <button type="button" className="oui-btn oui-btn-ghost" onClick={onRecheck} disabled={checking}>
            <RotateCw className={checking ? "owl-spin" : undefined} aria-hidden="true" />Check again
          </button>
        </div>
      </div>
    );
  }
  const shown = agents.slice(0, CHIP_LIMIT);
  const more = agents.length - shown.length;
  return (
    <div className="owl-agents" aria-live="polite">
      <span>Ready with</span>
      {shown.map((agent, index) => (
        <span key={agent.id} className="owl-ag" style={{ animationDelay: `${index * 60}ms` }}>
          {createElement(agentIconComponent(agent.icon), { size: 16, className: "owl-ag-icon" })}
          {agent.name}
          <Check size={14} className="owl-ok" aria-hidden="true" />
        </span>
      ))}
      {more > 0 && <span className="owl-ag is-more">+{more} more</span>}
    </div>
  );
}

/** Orbit's Welcome page (no projects yet): the ways to add one, and which agents are ready. */
export function OrbitWelcome({ onAction }: { onAction: (action: WelcomeAction) => void }) {
  const [version, setVersion] = useState("");
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const { detection, checking, recheck } = useDetectedAgents();
  const isRemote = typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__GROVE_REMOTE__;

  useEffect(() => {
    getVersion().then((res) => setVersion(res.version)).catch(() => {});
  }, []);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className="orbit-ui owl"
    >
      <div className="owl-aurora" aria-hidden="true"><i className="a1" /><i className="a2" /><i className="a3" /></div>
      <div className="owl-veil" aria-hidden="true" />
      <div className="owl-center">
        <div className="owl-mark"><GroveIcon size={96} /></div>
        <h1>Steer agents with context.</h1>
        <p className="owl-lead">
          Grove runs every coding agent side by side, each in its own worktree. You decide what they know — instructions, memory, linked projects — and review what they ship.
        </p>
        <div className="owl-choices">
          {ACTIONS.map(({ id, icon: Icon, title, description, tint, glow }, index) => (
            <button
              key={id}
              type="button"
              className={`owl-choice${index === 0 ? " is-primary" : ""}`}
              style={{ "--glow": glow, animationDelay: `${300 + index * 70}ms` } as CSSProperties}
              onClick={() => onAction(id)}
            >
              <span className="owl-cic" style={{ background: tint }}><Icon size={16} aria-hidden="true" /></span>
              <b>{title}</b>
              <span>{description}</span>
            </button>
          ))}
        </div>
        <AgentLine detection={detection} checking={checking} onRecheck={recheck} onInstall={() => setMarketplaceOpen(true)} />
      </div>
      {(version || isRemote) && (
        <p className="owl-version">
          {version && <span>v{version}</span>}
          {isRemote && <span className="owl-remote">Remote</span>}
        </p>
      )}
      <MarketplaceModal open={marketplaceOpen} initialTab="explore" onClose={() => { setMarketplaceOpen(false); recheck(); }} />
    </motion.div>
  );
}
