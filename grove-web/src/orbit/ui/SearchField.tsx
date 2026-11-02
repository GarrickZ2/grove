import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { Search } from "lucide-react";

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name; also the placeholder unless one is given. */
  label: string;
  /** Right edge (e.g. a "/" shortcut hint). */
  trailing?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

/** Search box: magnifier, borderless input, focus ring on the whole field. */
export function SearchField({ value, onChange, label, trailing, inputRef, className, placeholder, ...input }: SearchFieldProps) {
  return (
    <label className={`oui-search${className ? ` ${className}` : ""}`}>
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder ?? label}
        onChange={(event) => onChange(event.target.value)}
        {...input}
      />
      {trailing}
    </label>
  );
}
