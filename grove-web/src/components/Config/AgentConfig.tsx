import { useState } from "react";
import { motion } from "framer-motion";
import { Terminal, Sparkles } from "lucide-react";
import { Card, CardHeader, Input, Button } from "../ui";

interface AgentConfigProps {
  initialCommand: string;
}

const popularAgents = [
  { name: "Claude", command: "claude", color: "#d97706" },
  { name: "Cursor", command: "cursor", color: "#3b82f6" },
  { name: "Aider", command: "aider", color: "#8b5cf6" },
  { name: "Custom", command: "", color: "#71717a" },
];

export function AgentConfig({ initialCommand }: AgentConfigProps) {
  const [command, setCommand] = useState(initialCommand);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleQuickSelect = (cmd: string) => {
    setCommand(cmd);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#fafafa]">Coding Agent</h1>
        <p className="text-[#71717a] mt-1">
          Configure the AI coding agent that runs in your task sessions
        </p>
      </div>

      <div className="space-y-6">
        {/* Quick Select */}
        <Card>
          <CardHeader
            title="Quick Select"
            description="Choose a popular coding agent"
          />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {popularAgents.map((agent) => (
              <motion.button
                key={agent.name}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => handleQuickSelect(agent.command)}
                className={`p-4 rounded-lg border transition-all duration-200 text-left
                  ${
                    command === agent.command
                      ? "border-[#10b981] bg-[#10b981]/10"
                      : "border-[#27272a] hover:border-[#3f3f46] bg-[#1c1c1f]"
                  }`}
              >
                <div
                  className="w-8 h-8 rounded-lg mb-3 flex items-center justify-center"
                  style={{ backgroundColor: `${agent.color}20` }}
                >
                  <Sparkles className="w-4 h-4" style={{ color: agent.color }} />
                </div>
                <div className="font-medium text-[#fafafa]">{agent.name}</div>
                <div className="text-xs text-[#71717a] mt-0.5">
                  {agent.command || "Enter manually"}
                </div>
              </motion.button>
            ))}
          </div>
        </Card>

        {/* Command Input */}
        <Card>
          <CardHeader
            title="Agent Command"
            description="The command that will be executed to start your coding agent"
          />
          <div className="space-y-4">
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="Enter command (e.g., claude, cursor, aider)"
                />
              </div>
              <Button onClick={handleSave} variant={saved ? "secondary" : "primary"}>
                {saved ? "Saved!" : "Save"}
              </Button>
            </div>

            {/* Preview */}
            <div className="p-4 bg-[#0a0a0b] rounded-lg border border-[#27272a]">
              <div className="flex items-center gap-2 text-[#71717a] text-sm mb-2">
                <Terminal className="w-4 h-4" />
                <span>Preview</span>
              </div>
              <code className="text-[#10b981] font-mono">
                $ {command || "<command>"}
              </code>
            </div>
          </div>
        </Card>

        {/* Tips */}
        <Card className="bg-[#10b981]/5 border-[#10b981]/20">
          <div className="flex gap-3">
            <div className="flex-shrink-0">
              <div className="w-8 h-8 rounded-lg bg-[#10b981]/10 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-[#10b981]" />
              </div>
            </div>
            <div>
              <div className="font-medium text-[#fafafa]">Tip</div>
              <p className="text-sm text-[#a1a1aa] mt-1">
                The agent command will be automatically executed when you create a new
                task with a layout that includes an agent pane.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </motion.div>
  );
}
