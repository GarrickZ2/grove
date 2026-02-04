import { motion } from "framer-motion";
import { Check } from "lucide-react";

interface SelectOption {
  id: string;
  name: string;
  description?: string;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}

export function Select({ options, value, onChange, label }: SelectProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-[#a1a1aa] mb-3">
          {label}
        </label>
      )}
      <div className="space-y-2">
        {options.map((option) => (
          <motion.button
            key={option.id}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => onChange(option.id)}
            className={`w-full flex items-center justify-between p-4 rounded-lg border transition-all duration-200
              ${
                value === option.id
                  ? "bg-[#10b981]/10 border-[#10b981] text-[#fafafa]"
                  : "bg-[#141416] border-[#27272a] text-[#a1a1aa] hover:border-[#3f3f46] hover:bg-[#1c1c1f]"
              }`}
          >
            <div className="text-left">
              <div className="font-medium">{option.name}</div>
              {option.description && (
                <div className="text-sm text-[#71717a] mt-0.5">
                  {option.description}
                </div>
              )}
            </div>
            {value === option.id && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="flex-shrink-0 ml-3"
              >
                <Check className="w-5 h-5 text-[#10b981]" />
              </motion.div>
            )}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
