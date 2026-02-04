import { useState } from "react";
import { motion } from "framer-motion";
import { Copy, Check, Plug, ExternalLink } from "lucide-react";
import { Card, CardHeader, Button } from "../ui";

interface McpConfigProps {
  config: {
    name: string;
    type: string;
    command: string;
    args: string[];
  };
}

export function McpConfig({ config }: McpConfigProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (field: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const configFields = [
    { key: "name", label: "Name", value: config.name },
    { key: "type", label: "Type", value: config.type },
    { key: "command", label: "Command", value: config.command },
    { key: "args", label: "Args", value: JSON.stringify(config.args) },
  ];

  // Full JSON config for different formats
  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        grove: {
          command: config.command,
          args: config.args,
        },
      },
    },
    null,
    2
  );

  const claudeCodeConfig = JSON.stringify(
    {
      mcpServers: {
        grove: {
          type: config.type,
          command: config.command,
          args: config.args,
        },
      },
    },
    null,
    2
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#fafafa]">MCP Server</h1>
        <p className="text-[#71717a] mt-1">
          Grove provides MCP tools for AI agents to interact with tasks
        </p>
      </div>

      <div className="space-y-6">
        {/* Quick Config */}
        <Card>
          <CardHeader
            title="Server Configuration"
            description="Use these values to configure Grove MCP in your AI agent"
          />
          <div className="space-y-3">
            {configFields.map(({ key, label, value }) => (
              <div
                key={key}
                className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0b] border border-[#27272a]"
              >
                <div className="flex items-center gap-4">
                  <span className="text-sm text-[#71717a] w-20">{label}</span>
                  <code className="text-[#10b981] font-mono">{value}</code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy(key, value)}
                >
                  {copiedField === key ? (
                    <Check className="w-4 h-4 text-[#10b981]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        </Card>

        {/* Claude Desktop Config */}
        <Card>
          <CardHeader
            title="Claude Desktop"
            description="Add to ~/Library/Application Support/Claude/claude_desktop_config.json"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy("claude-desktop", claudeDesktopConfig)}
              >
                {copiedField === "claude-desktop" ? (
                  <Check className="w-4 h-4 text-[#10b981]" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            }
          />
          <pre className="p-4 bg-[#0a0a0b] rounded-lg border border-[#27272a] overflow-x-auto">
            <code className="text-sm text-[#a1a1aa] font-mono">{claudeDesktopConfig}</code>
          </pre>
        </Card>

        {/* Claude Code Config */}
        <Card>
          <CardHeader
            title="Claude Code"
            description="Add to ~/.claude/settings.json"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy("claude-code", claudeCodeConfig)}
              >
                {copiedField === "claude-code" ? (
                  <Check className="w-4 h-4 text-[#10b981]" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            }
          />
          <pre className="p-4 bg-[#0a0a0b] rounded-lg border border-[#27272a] overflow-x-auto">
            <code className="text-sm text-[#a1a1aa] font-mono">{claudeCodeConfig}</code>
          </pre>
        </Card>

        {/* Available Tools */}
        <Card>
          <CardHeader
            title="Available MCP Tools"
            description="These tools are available to AI agents via MCP"
          />
          <div className="space-y-2">
            {[
              { name: "grove_status", desc: "Get current task status and context" },
              { name: "grove_read_notes", desc: "Read task notes and requirements" },
              { name: "grove_read_review", desc: "Read code review comments" },
              { name: "grove_reply_review", desc: "Reply to review comments" },
              { name: "grove_complete_task", desc: "Complete and merge the task" },
            ].map((tool) => (
              <div
                key={tool.name}
                className="flex items-center gap-4 p-3 rounded-lg bg-[#0a0a0b] border border-[#27272a]"
              >
                <Plug className="w-4 h-4 text-[#10b981]" />
                <div>
                  <code className="text-sm text-[#fafafa] font-mono">{tool.name}</code>
                  <p className="text-xs text-[#71717a] mt-0.5">{tool.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Documentation Link */}
        <Card className="bg-[#3b82f6]/5 border-[#3b82f6]/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#3b82f6]/10 flex items-center justify-center">
                <ExternalLink className="w-5 h-5 text-[#3b82f6]" />
              </div>
              <div>
                <div className="font-medium text-[#fafafa]">Documentation</div>
                <p className="text-sm text-[#a1a1aa]">
                  Learn more about Grove MCP integration
                </p>
              </div>
            </div>
            <Button variant="secondary" size="sm">
              View Docs
            </Button>
          </div>
        </Card>
      </div>
    </motion.div>
  );
}
