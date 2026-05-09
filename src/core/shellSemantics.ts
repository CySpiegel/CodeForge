export interface ShellCommandSemantics {
  readonly isSearch: boolean;
  readonly isRead: boolean;
  readonly isList: boolean;
  readonly isReadOnly: boolean;
  readonly isDestructive: boolean;
  readonly usesNetwork: boolean;
  readonly usesBackgroundExecution: boolean;
  readonly usesShellExpansion: boolean;
  readonly commandNames: readonly string[];
  readonly summary: string;
}

const searchCommands = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"]);
const readCommands = new Set(["cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq", "tr"]);
const listCommands = new Set(["ls", "tree", "du"]);
const neutralCommands = new Set(["echo", "printf", "true", "false", ":"]);
const prefixCommands = new Set(["env", "command", "time", "nice", "nohup", "sudo"]);
const destructiveCommands = new Set(["rm", "rmdir", "mv", "chmod", "chown", "chgrp", "truncate", "dd", "mkfs", "mount", "umount"]);
const writeCommands = new Set(["cp", "mkdir", "touch", "ln", "tee", "sed", "perl", "python", "python3", "node", "npm", "pnpm", "yarn", "bun", "cargo", "go", "dotnet", "git"]);
const networkCommands = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "netcat", "telnet", "ftp"]);

export function classifyShellCommand(command: string): ShellCommandSemantics {
  const parts = splitCommandParts(command);
  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let hasReadOnlyCommand = false;
  let hasWriteOrUnknownCommand = false;
  let hasDestructiveCommand = false;
  let hasNetworkCommand = false;
  let hasBackgroundExecution = false;
  const commandNames: string[] = [];

  for (const part of parts) {
    if (part.operator) {
      if (part.operator.includes(">") || part.operator.includes("<")) {
        hasWriteOrUnknownCommand = true;
      }
      if (part.operator === "&") {
        hasBackgroundExecution = true;
        hasWriteOrUnknownCommand = true;
      }
      continue;
    }

    const commandName = firstCommandWord(part.text);
    if (!commandName || neutralCommands.has(commandName)) {
      continue;
    }

    commandNames.push(commandName);
    if (networkCommands.has(commandName)) {
      hasNetworkCommand = true;
    }

    if (isDestructiveCommand(commandName, part.text)) {
      hasDestructiveCommand = true;
    }

    if (searchCommands.has(commandName)) {
      hasSearch = true;
      hasReadOnlyCommand = true;
    } else if (readCommands.has(commandName)) {
      hasRead = true;
      hasReadOnlyCommand = true;
    } else if (listCommands.has(commandName)) {
      hasList = true;
      hasReadOnlyCommand = true;
    } else {
      hasWriteOrUnknownCommand = true;
    }
  }

  const usesShellExpansion = usesDynamicShellExpansion(command);
  const isReadOnly = hasReadOnlyCommand && !hasWriteOrUnknownCommand && !hasDestructiveCommand && !hasNetworkCommand && !usesShellExpansion;
  return {
    isSearch: hasSearch,
    isRead: hasRead,
    isList: hasList,
    isReadOnly,
    isDestructive: hasDestructiveCommand,
    usesNetwork: hasNetworkCommand,
    usesBackgroundExecution: hasBackgroundExecution,
    usesShellExpansion,
    commandNames,
    summary: summarizeShellSemantics({
      hasSearch,
      hasRead,
      hasList,
      isReadOnly,
      hasDestructiveCommand,
      hasNetworkCommand,
      hasBackgroundExecution,
      usesShellExpansion
    })
  };
}

interface CommandPart {
  readonly text: string;
  readonly operator?: string;
}

function splitCommandParts(command: string): readonly CommandPart[] {
  const parts: CommandPart[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      current += char;
      continue;
    }
    if (!quote) {
      const two = `${char}${next ?? ""}`;
      if (two === "&&" || two === "||" || two === ">>" || two === "<<") {
        pushTextPart(parts, current);
        parts.push({ text: two, operator: two });
        current = "";
        index++;
        continue;
      }
      if (char === "|" || char === ";" || char === ">" || char === "<" || char === "&") {
        pushTextPart(parts, current);
        parts.push({ text: char, operator: char });
        current = "";
        continue;
      }
    }

    current += char;
  }

  pushTextPart(parts, current);
  return parts;
}

function pushTextPart(parts: CommandPart[], text: string): void {
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ text: trimmed });
  }
}

function firstCommandWord(part: string): string | undefined {
  const words = part.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let index = 0;
  while (index < words.length) {
    const word = unquote(words[index]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) {
      index++;
      continue;
    }
    if (prefixCommands.has(word)) {
      index++;
      continue;
    }
    return basename(word);
  }
  return undefined;
}

function isDestructiveCommand(commandName: string, part: string): boolean {
  if (destructiveCommands.has(commandName)) {
    return true;
  }
  if (!writeCommands.has(commandName)) {
    return false;
  }
  const lowered = part.toLowerCase();
  return (
    /\bgit\s+(reset\s+--hard|clean\b|checkout\s+-f|restore\b.*\s--worktree\b)/.test(lowered) ||
    /\b(npm|pnpm|yarn)\s+publish\b/.test(lowered) ||
    /\bdotnet\s+nuget\s+push\b/.test(lowered)
  );
}

function summarizeShellSemantics(value: {
  readonly hasSearch: boolean;
  readonly hasRead: boolean;
  readonly hasList: boolean;
  readonly isReadOnly: boolean;
  readonly hasDestructiveCommand: boolean;
  readonly hasNetworkCommand: boolean;
  readonly hasBackgroundExecution: boolean;
  readonly usesShellExpansion: boolean;
}): string {
  if (value.hasDestructiveCommand) {
    return "destructive shell command";
  }
  if (value.hasBackgroundExecution) {
    return "background shell command";
  }
  if (value.hasNetworkCommand) {
    return "network-capable shell command";
  }
  if (value.usesShellExpansion) {
    return "shell command with dynamic expansion";
  }
  if (value.isReadOnly) {
    const kinds = [
      value.hasSearch ? "search" : undefined,
      value.hasRead ? "read" : undefined,
      value.hasList ? "list" : undefined
    ].filter((item): item is string => Boolean(item));
    return `${kinds.join("/") || "read-only"} shell command`;
  }
  return "shell command with possible side effects";
}

function usesDynamicShellExpansion(command: string): boolean {
  return /`[^`]*`|\$\(|\$\{/.test(command);
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
