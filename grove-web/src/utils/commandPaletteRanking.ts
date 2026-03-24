import type { Command, CommandPalettePageContext } from "../context/CommandPaletteContext";

export interface CommandUsageStats {
  count: number;
  lastUsedAt: number;
}

export type CommandUsageMap = Record<string, CommandUsageStats>;

interface MatchResult {
  command: Command;
  matchTier: number;
  matchScore: number;
  contextScore: number;
}

const CATEGORY_CONTEXT_SCORES: Record<string, Record<CommandPalettePageContext, number>> = {
  Navigation: { default: 72, tasks: 28, workspace: 18 },
  Project: { default: 52, tasks: 16, workspace: 28 },
  Mode: { default: 34, tasks: 34, workspace: 18 },
  "Task Actions": { default: 20, tasks: 82, workspace: 66 },
  "Action Panel": { default: 12, tasks: 52, workspace: 72 },
  "Info Panel": { default: 8, tasks: 46, workspace: 60 },
  "Project Actions": { default: 38, tasks: 20, workspace: 36 },
};

const DEFAULT_CONTEXT_SCORE = { default: 24, tasks: 24, workspace: 24 };

function normalizeText(value: string): string {
  return value.toLowerCase().trim();
}

function getCategoryContextScore(category: string, context: CommandPalettePageContext): number {
  return CATEGORY_CONTEXT_SCORES[category]?.[context] ?? DEFAULT_CONTEXT_SCORE[context];
}

function getUsageScore(commandId: string, usage: CommandUsageMap): number {
  const stats = usage[commandId];
  if (!stats) return 0;

  const now = Date.now();
  const daysSinceLastUse = (now - stats.lastUsedAt) / (1000 * 60 * 60 * 24);
  const frequencyBoost = Math.min(stats.count * 2, 12);
  const recencyBoost =
    daysSinceLastUse <= 1 ? 8 :
    daysSinceLastUse <= 7 ? 5 :
    daysSinceLastUse <= 30 ? 2 : 0;

  return frequencyBoost + recencyBoost;
}

export function getContextScore(
  command: Command,
  context: CommandPalettePageContext,
  usage: CommandUsageMap,
): number {
  const ranking = command.ranking;
  return (
    getCategoryContextScore(command.category, context) +
    (ranking?.base ?? 0) +
    (ranking?.contexts?.[context] ?? 0) +
    getUsageScore(command.id, usage)
  );
}

function fuzzySubsequenceScore(query: string, target: string): number {
  if (!query || !target) return 0;

  let queryIndex = 0;
  let consecutive = 0;
  let score = 0;

  for (let index = 0; index < target.length && queryIndex < query.length; index += 1) {
    if (target[index] === query[queryIndex]) {
      consecutive += 1;
      score += 2 + consecutive;
      queryIndex += 1;
    } else {
      consecutive = 0;
    }
  }

  if (queryIndex !== query.length) return 0;
  return Math.max(score - (target.length - query.length), 1);
}

function getInitialism(value: string): string {
  return value
    .split(/[\s:/()-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
}

function getCategoryAliases(category: string): string[] {
  const normalized = normalizeText(category);
  const aliases = new Set<string>([normalized]);

  if (normalized.endsWith(" panel")) {
    aliases.add(`${normalized}s`);
  }
  if (normalized.endsWith(" panels")) {
    aliases.add(normalized.slice(0, -1));
  }

  return Array.from(aliases);
}

function getMatchResult(command: Command, rawQuery: string, context: CommandPalettePageContext, usage: CommandUsageMap): MatchResult | null {
  const query = normalizeText(rawQuery);
  if (!query) {
    return {
      command,
      matchTier: 0,
      matchScore: 0,
      contextScore: getContextScore(command, context, usage),
    };
  }

  const name = normalizeText(command.name);
  const keywords = (command.keywords ?? []).map(normalizeText);
  const haystacks = [name, ...keywords];
  const initialisms = haystacks.map(getInitialism).filter(Boolean);
  const categoryAliases = getCategoryAliases(command.category);

  if (name.startsWith(query)) {
    return {
      command,
      matchTier: 4,
      matchScore: 160 - (name.length - query.length),
      contextScore: getContextScore(command, context, usage),
    };
  }

  if (haystacks.some((value) => value.split(/\s+/).some((token) => token.startsWith(query)))) {
    return {
      command,
      matchTier: 3,
      matchScore: 120,
      contextScore: getContextScore(command, context, usage),
    };
  }

  if (haystacks.some((value) => value.includes(query))) {
    return {
      command,
      matchTier: 2,
      matchScore: 90,
      contextScore: getContextScore(command, context, usage),
    };
  }

  if (initialisms.some((value) => value.startsWith(query))) {
    return {
      command,
      matchTier: 1,
      matchScore: 60,
      contextScore: getContextScore(command, context, usage),
    };
  }

  if (categoryAliases.some((value) => value.startsWith(query))) {
    return {
      command,
      matchTier: 0,
      matchScore: 36,
      contextScore: getContextScore(command, context, usage),
    };
  }

  if (categoryAliases.some((value) => value.includes(query))) {
    return {
      command,
      matchTier: 0,
      matchScore: 24,
      contextScore: getContextScore(command, context, usage),
    };
  }

  const fuzzyEnabled = query.length <= 3;
  if (fuzzyEnabled) {
    const fuzzyScore = Math.max(...haystacks.map((value) => fuzzySubsequenceScore(query, value)));
    const minimumFuzzyScore = query.length * 4;
    if (fuzzyScore >= minimumFuzzyScore) {
      return {
        command,
        matchTier: 0,
        matchScore: fuzzyScore,
        contextScore: getContextScore(command, context, usage),
      };
    }
  }

  return null;
}

export function rankCommands(
  commands: Command[],
  query: string,
  context: CommandPalettePageContext,
  usage: CommandUsageMap,
): Command[] {
  const uniqueCommands = new Map<string, Command>();
  for (const command of commands) {
    if (!uniqueCommands.has(command.id)) {
      uniqueCommands.set(command.id, command);
    }
  }

  const normalizedQuery = normalizeText(query);
  const matches = Array.from(uniqueCommands.values())
    .map((command) => getMatchResult(command, normalizedQuery, context, usage))
    .filter((result): result is MatchResult => result !== null);

  if (!normalizedQuery) {
    return matches
      .sort((left, right) =>
        right.contextScore - left.contextScore ||
        left.command.category.localeCompare(right.command.category) ||
        left.command.name.localeCompare(right.command.name))
      .map((result) => result.command);
  }

  return matches
    .sort((left, right) =>
      right.matchTier - left.matchTier ||
      right.matchScore - left.matchScore ||
      right.contextScore - left.contextScore ||
      left.command.name.localeCompare(right.command.name))
    .slice(0, 20)
    .map((result) => result.command);
}
