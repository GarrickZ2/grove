import { useState } from "react";
import { motion } from "framer-motion";
import { Check, LayoutGrid } from "lucide-react";
import { Card, CardHeader, Button } from "../ui";

interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  preview: string[][];
}

const layoutPresets: LayoutPreset[] = [
  {
    id: "single",
    name: "Single",
    description: "Default shell only",
    preview: [["Shell"]],
  },
  {
    id: "agent",
    name: "Agent",
    description: "Auto-start agent",
    preview: [["Agent"]],
  },
  {
    id: "agent-shell",
    name: "Agent + Shell",
    description: "Agent (60%) + Shell (40%)",
    preview: [["Agent", "Shell"]],
  },
  {
    id: "agent-grove-shell",
    name: "Agent + Grove + Shell",
    description: "Three pane layout",
    preview: [["Agent", "Grove", "Shell"]],
  },
  {
    id: "grove-agent",
    name: "Grove + Agent",
    description: "Grove (40%) + Agent (60%)",
    preview: [["Grove", "Agent"]],
  },
];

interface LayoutConfigProps {
  initialLayout: string;
}

export function LayoutConfig({ initialLayout }: LayoutConfigProps) {
  const [selectedLayout, setSelectedLayout] = useState(initialLayout);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#fafafa]">Task Layout</h1>
        <p className="text-[#71717a] mt-1">
          Configure the default pane layout for new tasks
        </p>
      </div>

      <div className="space-y-6">
        {/* Layout Presets */}
        <Card>
          <CardHeader
            title="Layout Presets"
            description="Select a preset or create a custom layout"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {layoutPresets.map((preset) => (
              <motion.button
                key={preset.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelectedLayout(preset.id)}
                className={`relative p-4 rounded-xl border text-left transition-all duration-200
                  ${
                    selectedLayout === preset.id
                      ? "border-[#10b981] bg-[#10b981]/5"
                      : "border-[#27272a] hover:border-[#3f3f46] bg-[#1c1c1f]"
                  }`}
              >
                {/* Selection indicator */}
                {selectedLayout === preset.id && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[#10b981] flex items-center justify-center"
                  >
                    <Check className="w-3 h-3 text-white" />
                  </motion.div>
                )}

                {/* Preview */}
                <div className="h-20 mb-4 bg-[#0a0a0b] rounded-lg border border-[#27272a] p-2 flex gap-1">
                  {preset.preview[0].map((pane, i) => (
                    <div
                      key={i}
                      className={`flex-1 rounded bg-[#27272a] flex items-center justify-center text-[10px] text-[#71717a] font-medium
                        ${pane === "Agent" ? "bg-[#10b981]/20 text-[#10b981]" : ""}
                        ${pane === "Grove" ? "bg-[#3b82f6]/20 text-[#3b82f6]" : ""}
                        ${pane === "Shell" ? "bg-[#71717a]/20 text-[#a1a1aa]" : ""}
                      `}
                    >
                      {pane}
                    </div>
                  ))}
                </div>

                {/* Info */}
                <div className="font-medium text-[#fafafa]">{preset.name}</div>
                <div className="text-xs text-[#71717a] mt-0.5">
                  {preset.description}
                </div>
              </motion.button>
            ))}

            {/* Custom option */}
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setSelectedLayout("custom")}
              className={`relative p-4 rounded-xl border text-left transition-all duration-200 border-dashed
                ${
                  selectedLayout === "custom"
                    ? "border-[#10b981] bg-[#10b981]/5"
                    : "border-[#3f3f46] hover:border-[#71717a] bg-transparent"
                }`}
            >
              {selectedLayout === "custom" && (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="absolute top-3 right-3 w-5 h-5 rounded-full bg-[#10b981] flex items-center justify-center"
                >
                  <Check className="w-3 h-3 text-white" />
                </motion.div>
              )}

              <div className="h-20 mb-4 rounded-lg border border-dashed border-[#3f3f46] flex items-center justify-center">
                <LayoutGrid className="w-6 h-6 text-[#71717a]" />
              </div>

              <div className="font-medium text-[#fafafa]">Custom...</div>
              <div className="text-xs text-[#71717a] mt-0.5">
                Build your own layout
              </div>
            </motion.button>
          </div>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} variant={saved ? "secondary" : "primary"}>
            {saved ? "Saved!" : "Save Layout"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
