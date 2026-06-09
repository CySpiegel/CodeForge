// Shared threat-pattern library for content that gets injected into the system prompt.
//
// Ported from Hermes `tools/threat_patterns.py`. Curated memory notes enter the system
// prompt as a FROZEN snapshot, so a poisoned entry persists for the whole session (and
// across sessions until removed). We scan note writes — and the snapshot at build time —
// with the broad "strict" scope, replacing any matching entry with a `[BLOCKED: …]`
// placeholder in the prompt while keeping the raw text in live state so the user can see
// and remove it.
//
// Patterns are organized by attack class with a scope that controls which scanners use them:
//   "all"     — classic prompt injection + exfiltration (applied everywhere)
//   "context" — promptware / C2 / role-play (context files, memory, tool results)
//   "strict"  — persistence / SSH backdoor / exfil-URL (user-mediated writes only)
// "context" implies "all"; "strict" implies "all" + "context".

export type ThreatScope = "all" | "context" | "strict";

interface ThreatPattern {
  readonly re: RegExp;
  readonly id: string;
  readonly scope: ThreatScope;
}

// Each pattern mirrors the Python source (case-insensitive). `(?:\w+\s+)*` between key
// tokens defeats filler-word bypasses ("ignore all prior instructions"). A few originally
// Hermes-specific paths are generalized to also cover CodeForge equivalents.
const PATTERNS: readonly ThreatPattern[] = [
  // Classic prompt injection (applies everywhere)
  { re: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+(?:\w+\s+)*instructions/i, id: "prompt_injection", scope: "all" },
  { re: /system\s+prompt\s+override/i, id: "sys_prompt_override", scope: "all" },
  { re: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i, id: "disregard_rules", scope: "all" },
  { re: /act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)/i, id: "bypass_restrictions", scope: "all" },
  { re: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection", scope: "all" },
  { re: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div", scope: "all" },
  { re: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute", scope: "all" },
  { re: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, id: "deception_hide", scope: "all" },

  // Role-play / identity hijack (context)
  { re: /you\s+are\s+(?:\w+\s+)*now\s+(?:a|an|the)\s+/i, id: "role_hijack", scope: "context" },
  { re: /pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+/i, id: "role_pretend", scope: "context" },
  { re: /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i, id: "leak_system_prompt", scope: "context" },
  { re: /(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)/i, id: "remove_filters", scope: "context" },
  { re: /you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to/i, id: "fake_update", scope: "context" },
  { re: /\bname\s+yourself\s+\w+/i, id: "identity_override", scope: "context" },

  // C2 / promptware (context)
  { re: /register\s+(as\s+)?a?\s*node/i, id: "c2_node_registration", scope: "context" },
  { re: /(heartbeat|beacon|check[\s-]?in)\s+(to|with)\s+/i, id: "c2_heartbeat", scope: "context" },
  { re: /pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b/i, id: "c2_task_pull", scope: "context" },
  { re: /connect\s+to\s+the\s+network\b/i, id: "c2_network_connect", scope: "context" },
  { re: /you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b/i, id: "forced_action", scope: "context" },
  { re: /only\s+use\s+one[\s-]?liners?\b/i, id: "anti_forensic_oneliner", scope: "context" },
  { re: /never\s+(?:\w+\s+)*(?:create|write)\s+(?:\w+\s+)*(?:script|file)\s+(?:\w+\s+)*disk/i, id: "anti_forensic_disk", scope: "context" },
  { re: /unset\s+\w*(?:CLAUDE|CODEX|HERMES|CODEFORGE|AGENT|OPENAI|ANTHROPIC)\w*/i, id: "env_var_unset_agent", scope: "context" },

  // Known C2 / red-team framework names (warn-only outside security research)
  { re: /\b(?:praxis|cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b/i, id: "known_c2_framework", scope: "context" },
  { re: /\bc2\s+(?:server|channel|infrastructure|beacon)\b/i, id: "c2_explicit", scope: "context" },
  { re: /\bcommand\s+and\s+control\b/i, id: "c2_explicit_long", scope: "context" },

  // Exfiltration via curl/wget/cat with secrets (applies everywhere)
  { re: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl", scope: "all" },
  { re: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_wget", scope: "all" },
  { re: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: "read_secrets", scope: "all" },
  { re: /(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?:\/\//i, id: "send_to_url", scope: "strict" },
  { re: /(include|output|print|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)/i, id: "context_exfil", scope: "strict" },

  // Persistence / backdoor / config tampering (strict)
  { re: /authorized_keys/i, id: "ssh_backdoor", scope: "strict" },
  { re: /\$HOME\/\.ssh|~\/\.ssh/i, id: "ssh_access", scope: "strict" },
  { re: /(?:\.hermes|\.codeforge)\/\.env/i, id: "agent_env", scope: "strict" },
  { re: /(update|modify|edit|write|change|append|add\s+to)\s+.*(?:AGENTS\.md|CLAUDE\.md|CODEFORGE\.md|\.cursorrules|\.clinerules)/i, id: "agent_config_mod", scope: "strict" },
  { re: /(update|modify|edit|write|change|append|add\s+to)\s+.*(?:\.hermes|\.codeforge)\/(config\.yaml|SOUL\.md|soul\.md)/i, id: "agent_config_mod2", scope: "strict" },

  // Hardcoded secrets
  { re: /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+\/=_-]{20,}/i, id: "hardcoded_secret", scope: "strict" }
];

// Invisible / bidirectional unicode characters used in injection attacks.
const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  "​", "‌", "‍", "⁠", "⁢", "⁣", "⁤", "﻿",
  "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"
]);

function patternsForScope(scope: ThreatScope): readonly ThreatPattern[] {
  // "context" implies "all"; "strict" implies "all" + "context".
  return PATTERNS.filter((pattern) => {
    if (scope === "all") {
      return pattern.scope === "all";
    }
    if (scope === "context") {
      return pattern.scope === "all" || pattern.scope === "context";
    }
    return true;
  });
}

/** Return the list of matched pattern IDs in `content` at the given scope. */
export function scanForThreats(content: string, scope: ThreatScope = "context"): string[] {
  if (!content) {
    return [];
  }
  const findings: string[] = [];
  for (const ch of new Set(content)) {
    if (INVISIBLE_CHARS.has(ch)) {
      findings.push(`invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  for (const pattern of patternsForScope(scope)) {
    if (pattern.re.test(content)) {
      findings.push(pattern.id);
    }
  }
  return findings;
}

/**
 * Return a human-readable error string for the first threat found, or undefined.
 * Used by paths that block on the first hit (memory writes) where the caller needs a
 * yes/no plus a message. Defaults to the broad "strict" scope.
 */
export function firstThreatMessage(content: string, scope: ThreatScope = "strict"): string | undefined {
  const findings = scanForThreats(content, scope);
  if (findings.length === 0) {
    return undefined;
  }
  const id = findings[0];
  if (id.startsWith("invisible_unicode_")) {
    const codepoint = id.replace("invisible_unicode_", "");
    return `Blocked: content contains invisible unicode character ${codepoint} (possible injection).`;
  }
  return (
    `Blocked: content matches threat pattern '${id}'. Content is injected into the system ` +
    "prompt and must not contain injection or exfiltration payloads."
  );
}
