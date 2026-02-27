/**
 * Config Validator
 * Validates environment configuration at startup and reports service modes.
 * Provides clear visibility into which services are real vs. simulated.
 */
import { logConfig } from "../logger";

export interface ServiceStatus {
  name: string;
  mode: "real" | "mock" | "simulation" | "unavailable";
  reason: string;
  envVarsNeeded?: string[];
}

export interface ConfigReport {
  services: ServiceStatus[];
  hasMockServices: boolean;
  missingCritical: string[];
}

export function validateConfig(): ConfigReport {
  const services: ServiceStatus[] = [];
  const missingCritical: string[] = [];

  // Database (required)
  if (!process.env.DATABASE_URL) {
    missingCritical.push("DATABASE_URL");
    services.push({
      name: "Database",
      mode: "unavailable",
      reason: "DATABASE_URL not set — server cannot start",
      envVarsNeeded: ["DATABASE_URL"],
    });
  } else {
    services.push({
      name: "Database",
      mode: "real",
      reason: "PostgreSQL connected",
    });
  }

  // Hive Blockchain
  const hasPostingKey = !!process.env.HIVE_POSTING_KEY;
  const hasActiveKey = !!process.env.HIVE_ACTIVE_KEY;
  const hasHiveUsername = !!process.env.HIVE_USERNAME;

  if (hasPostingKey || hasActiveKey) {
    services.push({
      name: "Hive Blockchain",
      mode: "real",
      reason: `${hasPostingKey ? "posting" : ""}${hasPostingKey && hasActiveKey ? "+" : ""}${hasActiveKey ? "active" : ""} key configured${hasHiveUsername ? ` for @${process.env.HIVE_USERNAME}` : ""}`,
    });
  } else {
    services.push({
      name: "Hive Blockchain",
      mode: "mock",
      reason: "No Hive keys — transfers and broadcasts are simulated",
      envVarsNeeded: ["HIVE_POSTING_KEY", "HIVE_ACTIVE_KEY", "HIVE_USERNAME"],
    });
  }

  // IPFS
  const hasIpfsUrl = !!process.env.IPFS_API_URL;
  if (hasIpfsUrl) {
    services.push({
      name: "IPFS",
      mode: "real",
      reason: `Connected to ${process.env.IPFS_API_URL}`,
    });
  } else {
    services.push({
      name: "IPFS",
      mode: "mock",
      reason: "IPFS daemon not detected — file operations are in-memory only",
      envVarsNeeded: ["IPFS_API_URL"],
    });
  }

  // SPK PoA
  const hasSpkUrl = !!process.env.SPK_POA_URL;
  if (hasSpkUrl) {
    services.push({
      name: "SPK PoA Validation",
      mode: "real",
      reason: `Live validation via ${process.env.SPK_POA_URL}`,
    });
  } else {
    services.push({
      name: "SPK PoA Validation",
      mode: "simulation",
      reason: "No SPK node — challenges use simulated responses",
      envVarsNeeded: ["SPK_POA_URL"],
    });
  }

  // Hive Broadcasts (depends on posting key)
  if (hasPostingKey) {
    services.push({
      name: "Hive Broadcasts",
      mode: "real",
      reason: "PoA results and reputation updates broadcast to chain",
    });
  } else {
    services.push({
      name: "Hive Broadcasts",
      mode: "mock",
      reason: "PoA results logged locally only",
      envVarsNeeded: ["HIVE_POSTING_KEY"],
    });
  }

  // Encoding webhook
  const hasWebhookSecret = !!process.env.ENCODING_WEBHOOK_SECRET;
  services.push({
    name: "Encoding Webhooks",
    mode: hasWebhookSecret ? "real" : "mock",
    reason: hasWebhookSecret ? "HMAC-signed webhooks enabled" : "Webhook signing disabled",
    envVarsNeeded: hasWebhookSecret ? undefined : ["ENCODING_WEBHOOK_SECRET"],
  });

  const hasMockServices = services.some(
    (s) => s.mode === "mock" || s.mode === "simulation"
  );

  return { services, hasMockServices, missingCritical };
}

export function printStartupReport(report: ConfigReport): void {
  const isProduction = process.env.NODE_ENV === "production";
  const divider = "=".repeat(62);

  logConfig.info("");
  logConfig.info(divider);
  logConfig.info("  HivePoA (SPK Network 2.0) — Service Status Report");
  logConfig.info(divider);

  const modeLabel = (mode: string) => {
    switch (mode) {
      case "real":
        return "[  LIVE  ]";
      case "mock":
        return "[  MOCK  ]";
      case "simulation":
        return "[  SIM   ]";
      case "unavailable":
        return "[ MISSING]";
      default:
        return `[${mode}]`;
    }
  };

  for (const service of report.services) {
    const label = modeLabel(service.mode);
    const pad = " ".repeat(Math.max(0, 22 - service.name.length));
    logConfig.info(`  ${label} ${service.name}${pad} ${service.reason}`);
  }

  logConfig.info(divider);

  if (report.missingCritical.length > 0) {
    logConfig.error("");
    logConfig.error("  CRITICAL: Missing required environment variables:");
    for (const v of report.missingCritical) {
      logConfig.error(`    - ${v}`);
    }
    logConfig.error("");
  }

  if (report.hasMockServices) {
    logConfig.warn("");
    logConfig.warn(
      "  WARNING: Some services are running in mock/simulation mode."
    );
    logConfig.warn("  To enable full production functionality, set:");

    const allNeeded: string[] = [];
    for (const service of report.services) {
      if (service.envVarsNeeded) {
        for (const v of service.envVarsNeeded) {
          if (allNeeded.indexOf(v) === -1) {
            allNeeded.push(v);
          }
        }
      }
    }

    for (let i = 0; i < allNeeded.length; i++) {
      logConfig.warn(`    - ${allNeeded[i]}`);
    }

    logConfig.warn("");
    logConfig.warn("  See .env.example for configuration details.");
    logConfig.warn("");
  } else {
    logConfig.info("");
    logConfig.info("  All services running in LIVE mode.");
    logConfig.info("");
  }

  logConfig.info(
    `  Environment: ${isProduction ? "PRODUCTION" : "DEVELOPMENT"}`
  );
  logConfig.info(divider);
  logConfig.info("");
}
