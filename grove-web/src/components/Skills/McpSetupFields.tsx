import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "../ui";
import { mcpIconButtonClass, mcpInputClass } from "./McpConnectionViews";
import type { Variable } from "./mcpSetupTypes";

export function VariableDefinitions({
  variables,
  onChange,
  remote,
}: {
  variables: Variable[];
  onChange: (value: Variable[]) => void;
  remote: boolean;
}) {
  const update = (id: string, change: Partial<Variable>) =>
    onChange(
      variables.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--color-text)]">
          {remote ? "Custom headers" : "Environment variables"}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            onChange([
              ...variables,
              {
                id: crypto.randomUUID(),
                name: "",
                required: true,
                secret: true,
              },
            ])
          }
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add field
        </Button>
      </div>
      {variables.length === 0 && (
        <p className="text-xs leading-5 text-[var(--color-text-muted)]">
          Add fields for any additional credentials this server requires.
        </p>
      )}
      {variables.map((variable, index) => (
        <div
          key={variable.id}
          className="rounded-lg border border-[var(--color-border)] p-3"
        >
          <div className="flex items-center gap-2">
            <input
              aria-label={`Field ${index + 1} name`}
              className={`${mcpInputClass} !mt-0`}
              placeholder={remote ? "X-API-Key" : "API_TOKEN"}
              value={variable.name}
              onChange={(event) =>
                update(variable.id, { name: event.target.value })
              }
            />
            <button
              type="button"
              aria-label={`Remove field ${index + 1}`}
              className={mcpIconButtonClass}
              onClick={() =>
                onChange(variables.filter((item) => item.id !== variable.id))
              }
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex gap-5 text-xs text-[var(--color-text-muted)]">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={variable.required}
                onChange={(event) =>
                  update(variable.id, { required: event.target.checked })
                }
              />
              Required
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={variable.secret}
                onChange={(event) =>
                  update(variable.id, { secret: event.target.checked })
                }
              />
              Secret
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Footer({
  onClose,
  label,
  disabled,
  busy,
  hint,
  onAction,
}: {
  onClose: () => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  onAction?: () => void;
}) {
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-6 py-4">
      {hint && (
        <p className="mr-auto text-xs text-[var(--color-text-muted)]">{hint}</p>
      )}
      <Button variant="secondary" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button
        type={onAction ? "button" : "submit"}
        disabled={disabled || busy}
        onClick={onAction}
      >
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {label}
      </Button>
    </footer>
  );
}

export function McpSetupCredentials({
  variables,
  values,
  onChange,
  disabled,
}: {
  variables: Variable[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-3">
      {variables
        .filter((field) => field.name.trim())
        .map((field) => (
          <label key={field.id} className="mt-3 block text-xs font-medium">
            {field.name.trim()}
            {field.required && " *"}
            <input
              aria-label={field.name.trim()}
              className={mcpInputClass}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              disabled={disabled}
              value={values[field.name.trim()] ?? ""}
              onChange={(event) =>
                onChange({ ...values, [field.name.trim()]: event.target.value })
              }
            />
          </label>
        ))}
    </div>
  );
}
