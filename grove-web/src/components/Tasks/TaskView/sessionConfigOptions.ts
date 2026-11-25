import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectValue,
} from "../../../api/tasks";

export const isConfigGroup = (
  option: SessionConfigSelectValue | SessionConfigSelectGroup,
): option is SessionConfigSelectGroup => "group" in option;

export const flattenConfigValues = (
  option: SessionConfigOption,
): SessionConfigSelectValue[] => {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    isConfigGroup(entry) ? entry.options : [entry],
  );
};

export const configDropdownValues = (
  option: SessionConfigOption,
): Array<SessionConfigSelectValue & { group?: string }> => {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    isConfigGroup(entry)
      ? entry.options.map((value) => ({ ...value, group: entry.name }))
      : [entry],
  );
};

export const configCategoryMatches = (
  option: SessionConfigOption,
  category: "model" | "mode" | "thought_level" | "speed",
) => {
  const value = option.category?.toLowerCase();
  if (category === "thought_level") {
    return value === "thought_level" || value === "thoughtlevel" || value === "effort";
  }
  return value === category;
};

export const quickConfigOptions = (options: SessionConfigOption[]) => {
  const model = options.find((option) => configCategoryMatches(option, "model"));
  const mode = options.find((option) => configCategoryMatches(option, "mode"));
  const thinking = options.find((option) =>
    configCategoryMatches(option, "thought_level"),
  );
  return { model, mode, thinking };
};

/** Speed options (such as Fast mode) first, so they sit next to the model. */
export const speedFirst = (options: SessionConfigOption[]) => {
  const isSpeed = (option: SessionConfigOption) => configCategoryMatches(option, "speed");
  return [...options.filter(isSpeed), ...options.filter((option) => !isSpeed(option))];
};
