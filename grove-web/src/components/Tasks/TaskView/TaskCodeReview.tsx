import { motion } from "framer-motion";
import { X, Code } from "lucide-react";
import { Button } from "../../ui";

interface TaskCodeReviewProps {
  onClose: () => void;
}

const REVIEW_URL = "http://localhost:4966/";

export function TaskCodeReview({ onClose }: TaskCodeReviewProps) {
  return (
    <motion.div
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 200 }}
      className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text)]">
          <Code className="w-4 h-4" />
          <span className="font-medium">Code Review</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="w-4 h-4 mr-1" />
          Close
        </Button>
      </div>

      {/* iframe */}
      <div className="flex-1 relative">
        <iframe
          src={REVIEW_URL}
          className="absolute inset-0 w-full h-full border-0"
          title="Code Review"
        />
      </div>
    </motion.div>
  );
}
