import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined, // JSON in production
});

// Pre-configured child loggers for each subsystem
export const logPoA = logger.child({ component: "poa-engine" });
export const logIPFS = logger.child({ component: "ipfs" });
export const logHive = logger.child({ component: "hive" });
export const logRoutes = logger.child({ component: "routes" });
export const logWS = logger.child({ component: "websocket" });
export const logDB = logger.child({ component: "database" });
export const logEncoding = logger.child({ component: "encoding" });
export const logSeed = logger.child({ component: "seed" });
export const logP2P = logger.child({ component: "p2p-signaling" });
export const logAutoPin = logger.child({ component: "auto-pin" });
export const logBeneficiary = logger.child({ component: "beneficiary" });
export const logBlocklist = logger.child({ component: "blocklist" });
export const logCDN = logger.child({ component: "cdn" });
export const logConfig = logger.child({ component: "config" });
export const logScheduler = logger.child({ component: "job-scheduler" });
export const logPin = logger.child({ component: "pin-manager" });
export const logThreeSpeak = logger.child({ component: "threespeak" });
export const logTranscode = logger.child({ component: "transcoding" });
export const logUpload = logger.child({ component: "upload" });
export const logVideo = logger.child({ component: "video-processor" });
export const logSPK = logger.child({ component: "spk-poa" });
export const logWoT = logger.child({ component: "web-of-trust" });
