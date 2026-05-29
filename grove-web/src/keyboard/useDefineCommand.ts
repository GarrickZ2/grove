import { useCallback, useEffect, useRef, type DependencyList } from "react";
import { commandRegistry } from "./CommandRegistry";
import type { CommandDef, KeyBinding, MenuContribution } from "./types";

interface DefineCommandInput<TArgs> {
  id: string;
  name: string;
  category: string;
  description?: string;
  defaultBindings?: KeyBinding[];
  defaultWhen?: string;
  scope?: string;
  preventDefault?: boolean;
  passThroughTextInput?: boolean;
  hidden?: boolean;
  readonly?: boolean;
  menus?: MenuContribution[];
  handler: (args?: TArgs) => void | Promise<void>;
  enabled?: () => boolean;
}

/**
 * One-stop command definition: declare metadata + handler + binding in a
 * single place, get back a typed invoker for the JSX side. Equivalent to
 * (catalog entry) + (useCommand handler) + (useInvoke) combined.
 *
 *   function ArchiveButton({ taskId }: { taskId: string }) {
 *     const archive = useDefineCommand({
 *       id: "task.archive",
 *       name: "Archive Task",
 *       category: "Task",
 *       defaultBindings: [{ key: "Mod+Shift+A" }],
 *       scope: "workspace",
 *       handler: (args: { taskId: string }) => archiveTask(args.taskId),
 *     });
 *     return <button onClick={() => archive({ taskId })}>Archive</button>;
 *   }
 *
 * The command appears in Settings UI / Command Palette / HelpOverlay
 * while the component is mounted. Static commands belong in catalog/*.ts
 * — useDefineCommand is for dynamic / feature-specific commands.
 *
 * `deps` controls re-registration. Pass [] to register once at mount.
 */
export function useDefineCommand<TArgs = unknown>(
  input: DefineCommandInput<TArgs>,
  deps: DependencyList = [],
): (args?: TArgs) => boolean {
  "use no memo";
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  useEffect(() => {
    const def: CommandDef = {
      id: input.id,
      name: input.name,
      category: input.category,
      description: input.description,
      defaultBindings: input.defaultBindings,
      defaultWhen: input.defaultWhen,
      scope: input.scope,
      preventDefault: input.preventDefault,
      passThroughTextInput: input.passThroughTextInput,
      hidden: input.hidden,
      readonly: input.readonly,
      menus: input.menus,
    };
    return commandRegistry.contribute(
      def,
      (args) => inputRef.current.handler(args as TArgs),
      input.enabled
        ? () => {
            const cur = inputRef.current.enabled;
            return cur ? cur() : true;
          }
        : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller deps + a few static fields
  }, [input.id, input.scope, ...deps]);

  return useCallback(
    (args?: TArgs) => commandRegistry.invoke(input.id, args),
    [input.id],
  );
}
