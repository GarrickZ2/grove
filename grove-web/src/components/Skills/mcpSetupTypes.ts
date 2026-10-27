import type { McpAccessOptions } from "./McpAgentAccess";
export type Runtime = "remote" | "npm" | "pypi" | "oci";
export type Variable = {
  id: string;
  name: string;
  required: boolean;
  secret: boolean;
};
export type Definition = Record<string, unknown>;

export function definitions(variables: Variable[]) {
  return variables
    .filter((item) => item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      isRequired: item.required,
      isSecret: item.secret,
    }));
}

export type SetupProps = {
  access: McpAccessOptions;
  definitionLocked: boolean;
  onCreate: (
    manifest: Definition,
    values: Record<string, string>,
  ) => Promise<void>;
};
