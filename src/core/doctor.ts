export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly category: string;
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly recommendation?: string;
}

export function worstDoctorStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "pass";
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const status = worstDoctorStatus(checks).toUpperCase();
  const lines = [`CodeForge Doctor: ${status}`];
  const categories = new Map<string, DoctorCheck[]>();
  for (const check of checks) {
    const category = categories.get(check.category) ?? [];
    category.push(check);
    categories.set(check.category, category);
  }

  for (const [category, categoryChecks] of categories) {
    lines.push("", category);
    for (const check of categoryChecks) {
      lines.push(`[${check.status}] ${check.name}: ${check.detail}`);
      if (check.recommendation) {
        lines.push(`  Fix: ${check.recommendation}`);
      }
    }
  }

  return lines.join("\n");
}
