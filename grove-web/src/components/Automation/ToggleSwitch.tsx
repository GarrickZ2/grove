import { motion } from "framer-motion";
export function ToggleSwitch({
  value,
  onChange,
  disabled = false,
  label = "Enable automation",
}: {
  value: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      title={disabled ? "Saving…" : value ? "Disable" : "Enable"}
      className={`mt-1 flex-shrink-0 ${disabled ? "cursor-wait opacity-50" : ""}`}
    >
      <span
        className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${
          value ? "bg-[var(--color-highlight)]" : "bg-[var(--color-bg-tertiary)]"
        }`}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className={`block w-4 h-4 rounded-full bg-[var(--color-bg)] shadow-sm absolute top-0.5 ${
            value ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

