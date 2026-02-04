import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
}

export function Card({ children, className = "", hover = false, onClick }: CardProps) {
  const baseStyles =
    "bg-[#141416] border border-[#27272a] rounded-xl p-5";

  const hoverStyles = hover
    ? "hover:border-[#3f3f46] hover:bg-[#1c1c1f] cursor-pointer"
    : "";

  if (hover || onClick) {
    return (
      <motion.div
        whileHover={hover ? { y: -2, scale: 1.01 } : undefined}
        transition={{ duration: 0.2 }}
        onClick={onClick}
        className={`${baseStyles} ${hoverStyles} transition-colors duration-200 ${className}`}
      >
        {children}
      </motion.div>
    );
  }

  return <div className={`${baseStyles} ${className}`}>{children}</div>;
}

interface CardHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function CardHeader({ title, description, action }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <h3 className="text-lg font-semibold text-[#fafafa]">{title}</h3>
        {description && (
          <p className="text-sm text-[#71717a] mt-1">{description}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
