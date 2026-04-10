import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";

export interface ServerInfo {
  hostname: string;
  port: number;
  monitoring?: number;
}

/**
 * Minimal NATS server launcher for tests.
 *
 * Two modes:
 *  1. External server — set `NATS_SERVER_URL` (e.g. `nats://localhost:4222`).
 *     `stop()` is a no-op; the caller manages the server lifetime.
 *  2. Spawned binary — set `NATS_SERVER_BIN` or ensure `nats-server` is on PATH.
 */
export class NatsServer {
  readonly port: number;
  readonly hostname: string;
  readonly monitoring?: number;
  private process: ChildProcess | null;
  private stopped = false;

  private constructor(info: ServerInfo, proc: ChildProcess | null) {
    this.port = info.port;
    this.hostname = info.hostname;
    this.monitoring = info.monitoring;
    this.process = proc;
  }

  get uri(): string {
    return `nats://${this.hostname}:${this.port}`;
  }

  static async start(
    conf: Record<string, unknown> = {},
  ): Promise<NatsServer> {
    // --- External server mode ---
    const externalUrl = process.env.NATS_SERVER_URL;
    if (externalUrl) {
      const url = new URL(externalUrl);
      const hostname = url.hostname;
      const port = parseInt(url.port || "4222", 10);
      // Best-effort: probe the monitoring endpoint if NATS_MONITORING_URL is set.
      const monUrl = process.env.NATS_MONITORING_URL;
      let monitoring: number | undefined;
      if (monUrl) {
        monitoring = parseInt(new URL(monUrl).port || "8222", 10);
        await waitForMonitoring({ hostname, port, monitoring }, 10000);
      }
      return new NatsServer({ hostname, port, monitoring }, null);
    }

    // --- Spawned binary mode ---
    const exe = process.env.NATS_SERVER_BIN ?? "nats-server";
    const tmp = os.tmpdir();
    const dir = fs.mkdtempSync(path.join(tmp, "nats-"));

    const confData: Record<string, unknown> = {
      host: "127.0.0.1",
      port: -1,
      http: "127.0.0.1:-1",
      ports_file_dir: tmp,
      ...conf,
    };

    const confFile = path.join(dir, "server.conf");
    fs.writeFileSync(confFile, toConf(confData));

    const srv = spawn(exe, ["-c", confFile], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Wait for the ports file (written by nats-server after binding).
    const portsFile = path.join(tmp, `nats-server_${srv.pid}.ports`);
    const ports = await waitForFile(portsFile, 10000);
    const info = parsePorts(ports as PortsFile);

    // Wait until the monitoring endpoint is reachable.
    await waitForMonitoring(info, 10000);

    return new NatsServer(info, srv);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.process) return; // external server — nothing to stop
    this.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process!.kill("SIGKILL");
      }, 3000);
      this.process!.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PortsFile {
  nats?: string[];
  monitoring?: string[];
}

function parseHostport(s: string): { hostname: string; port: number } {
  // Strip protocol prefix if present.
  const idx = s.indexOf("://");
  if (idx !== -1) {
    s = s.slice(idx + 3);
  }
  const [hostname, ps] = s.split(":");
  return { hostname, port: parseInt(ps, 10) };
}

function parsePorts(raw: PortsFile): ServerInfo {
  const nats = raw.nats?.[0]
    ? parseHostport(raw.nats[0])
    : { hostname: "127.0.0.1", port: 4222 };
  const mon = raw.monitoring?.[0]
    ? parseHostport(raw.monitoring[0]).port
    : undefined;
  return { hostname: nats.hostname, port: nats.port, monitoring: mon };
}

function toConf(
  o: Record<string, unknown>,
  indent = "",
): string {
  const pad = indent + "  ";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) {
      lines.push(`${pad}${k} [`);
      v.forEach((item) => {
        if (typeof item === "object" && item !== null) {
          lines.push(`${pad}  {`);
          lines.push(toConf(item as Record<string, unknown>, pad + "  "));
          lines.push(`${pad}  }`);
        } else {
          lines.push(`${pad}  ${item}`);
        }
      });
      lines.push(`${pad}]`);
    } else if (typeof v === "object" && v !== null) {
      lines.push(`${pad}${k} {`);
      lines.push(toConf(v as Record<string, unknown>, pad));
      lines.push(`${pad}}`);
    } else if (
      typeof v === "string" &&
      v.length > 0 &&
      v.charAt(0) >= "0" &&
      v.charAt(0) <= "9"
    ) {
      lines.push(`${pad}${k}: "${v}"`);
    } else {
      lines.push(`${pad}${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

function waitForFile(filePath: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed) {
          clearInterval(interval);
          resolve(parsed);
        }
      } catch {
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for ${filePath}`));
        }
      }
    }, 100);
  });
}

function waitForMonitoring(
  info: ServerInfo,
  timeoutMs: number,
): Promise<void> {
  if (!info.monitoring) return Promise.resolve();
  const url = `http://${info.hostname}:${info.monitoring}/varz`;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      http
        .get(url, (res) => {
          if (res.statusCode === 200) {
            res.resume(); // drain response
            return resolve();
          }
          scheduleRetry();
        })
        .on("error", scheduleRetry);
    };
    const scheduleRetry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("NATS server did not become ready"));
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}
