import { NetworkPolicy } from "./types";

export interface UrlPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function assertUrlAllowed(rawUrl: string, policy: NetworkPolicy): void {
  const result = isUrlAllowed(rawUrl, policy);
  if (!result.allowed) {
    throw new Error(result.reason ?? `Network destination is blocked: ${rawUrl}`);
  }
}

export function isUrlAllowed(rawUrl: string, policy: NetworkPolicy): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `Unsupported URL protocol: ${url.protocol}` };
  }

  const host = normalizeHost(url.hostname);
  if (isLocalhost(host) || isPrivateIp(host)) {
    return { allowed: true };
  }

  if (parseIpv4(host) !== undefined) {
    return {
      allowed: false,
      reason: `Blocked public IP network destination ${url.origin}. CodeForge only permits localhost, private IP ranges, and explicitly configured on-prem hostnames.`
    };
  }

  for (const entry of policy.allowlist) {
    if (matchesAllowlistEntry(url, host, entry.trim())) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Blocked network destination ${url.origin}. Add an on-prem hostname to codeforge.network.allowlist only when it resolves inside your private network.`
  };
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1";
}

function isPrivateIp(host: string): boolean {
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) {
    return (
      isInIpv4Cidr(ipv4, parseIpv4("127.0.0.0")!, 8) ||
      isInIpv4Cidr(ipv4, parseIpv4("10.0.0.0")!, 8) ||
      isInIpv4Cidr(ipv4, parseIpv4("172.16.0.0")!, 12) ||
      isInIpv4Cidr(ipv4, parseIpv4("192.168.0.0")!, 16) ||
      isInIpv4Cidr(ipv4, parseIpv4("169.254.0.0")!, 16)
    );
  }

  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function matchesAllowlistEntry(url: URL, host: string, entry: string): boolean {
  if (!entry) {
    return false;
  }

  if (entry.includes("://")) {
    try {
      const allowedUrl = new URL(entry);
      return allowedUrl.origin.toLowerCase() === url.origin.toLowerCase();
    } catch {
      return false;
    }
  }

  if (entry.includes("/")) {
    const [range, bitsText] = entry.split("/", 2);
    const hostIp = parseIpv4(host);
    const rangeIp = parseIpv4(range);
    const bits = Number(bitsText);
    return hostIp !== undefined && rangeIp !== undefined && Number.isInteger(bits) && isInIpv4Cidr(hostIp, rangeIp, bits);
  }

  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1).toLowerCase();
    return host.endsWith(suffix);
  }

  return host === entry.toLowerCase();
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return undefined;
    }
    result = (result << 8) + octet;
  }

  return result >>> 0;
}

function isInIpv4Cidr(ip: number, range: number, bits: number): boolean {
  if (bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (range & mask);
}
