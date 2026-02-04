import { useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, AlertTriangle, Info, FolderOpen } from "lucide-react";
import { Card, CardHeader, Input, Button, Toggle } from "../ui";

interface HookConfigProps {
  initialEnabled: boolean;
  initialScriptPath: string;
}

export function HookConfig({ initialEnabled, initialScriptPath }: HookConfigProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [scriptPath, setScriptPath] = useState(initialScriptPath);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const notificationLevels = [
    {
      level: "notice",
      icon: Info,
      color: "#3b82f6",
      title: "Notice",
      description: "Informational messages",
    },
    {
      level: "warn",
      icon: AlertTriangle,
      color: "#f59e0b",
      title: "Warning",
      description: "Important alerts",
    },
    {
      level: "critical",
      icon: AlertCircle,
      color: "#ef4444",
      title: "Critical",
      description: "Urgent notifications",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#fafafa]">Hook Configuration</h1>
        <p className="text-[#71717a] mt-1">
          Configure notification hooks for task events
        </p>
      </div>

      <div className="space-y-6">
        {/* Enable Toggle */}
        <Card>
          <Toggle
            enabled={enabled}
            onChange={setEnabled}
            label="Enable Hooks"
            description="Receive notifications when agents send hook events"
          />
        </Card>

        {/* Script Path */}
        <Card className={!enabled ? "opacity-50 pointer-events-none" : ""}>
          <CardHeader
            title="Hook Script"
            description="Path to your notification script"
          />
          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                value={scriptPath}
                onChange={(e) => setScriptPath(e.target.value)}
                placeholder="~/.grove/hooks/notify.sh"
              />
            </div>
            <Button variant="secondary">
              <FolderOpen className="w-4 h-4" />
            </Button>
          </div>
        </Card>

        {/* Notification Levels */}
        <Card className={!enabled ? "opacity-50 pointer-events-none" : ""}>
          <CardHeader
            title="Notification Levels"
            description="These are the notification levels your hook script will receive"
          />
          <div className="space-y-3">
            {notificationLevels.map(({ level, icon: Icon, color, title, description }) => (
              <div
                key={level}
                className="flex items-center gap-4 p-3 rounded-lg bg-[#0a0a0b] border border-[#27272a]"
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${color}15` }}
                >
                  <Icon className="w-5 h-5" style={{ color }} />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-[#fafafa]">{title}</div>
                  <div className="text-sm text-[#71717a]">{description}</div>
                </div>
                <code className="text-xs text-[#71717a] font-mono bg-[#27272a] px-2 py-1 rounded">
                  {level}
                </code>
              </div>
            ))}
          </div>
        </Card>

        {/* Example Usage */}
        <Card className={!enabled ? "opacity-50 pointer-events-none" : ""}>
          <CardHeader
            title="Usage"
            description="Agents can trigger hooks using the grove CLI"
          />
          <div className="p-4 bg-[#0a0a0b] rounded-lg border border-[#27272a] font-mono text-sm">
            <div className="text-[#71717a]"># Send a notification from your agent</div>
            <div className="text-[#10b981] mt-1">
              $ grove hooks notice "Task completed!"
            </div>
            <div className="text-[#10b981] mt-1">
              $ grove hooks warn "Review needed"
            </div>
            <div className="text-[#10b981] mt-1">
              $ grove hooks critical "Build failed"
            </div>
          </div>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} variant={saved ? "secondary" : "primary"}>
            {saved ? "Saved!" : "Save Changes"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
