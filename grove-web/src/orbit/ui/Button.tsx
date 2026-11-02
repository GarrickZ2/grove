import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  iconOnly?: boolean;
  /** `sm` (28px) sits in card heads, rows and footers; page headers use 32px. */
  size?: "md" | "sm";
  /** Destructive: error-colored text and hover. */
  danger?: boolean;
}

export function Button({ variant = "secondary", iconOnly = false, size = "md", danger = false, className, type = "button", ...rest }: ButtonProps) {
  const classes = `oui-btn oui-btn-${variant}${iconOnly ? " oui-btn-icon" : ""}${size === "sm" ? " oui-btn-sm" : ""}${danger ? " oui-btn-danger" : ""}${className ? ` ${className}` : ""}`;
  return <button type={type} className={classes} {...rest} />;
}
