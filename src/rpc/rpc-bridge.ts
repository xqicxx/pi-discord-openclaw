// RPC bridge — 懒启动 pi --mode rpc 子进程，JSONL over stdio（笔记 22）。
// 参照：codex-telegram-bot src/acp/transport.ts（JSON-RPC over stdio）+ pi rpc.md 协议。
// 仅用于「只读/导出」终端命令（export_html 等）；写会话命令不经过此桥（BACKLOG 约束）。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TAG = "[pi-discord-openclaw]";

/** RPC 命令返回体（pi rpc.md response 子集）。 */
export interface RpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
}

/** 懒启动 RPC 桥：首次调用才 spawn，空闲自动回收。 */
export class PiRpcBridge {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, (resp: RpcResponse) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionDir: string | undefined;
  private readonly piPath: string;
  private readonly idleMs: number;

  constructor(options: { sessionDir?: string; piPath?: string; idleMs?: number } = {}) {
    this.sessionDir = options.sessionDir;
    this.idleMs = options.idleMs ?? 30_000;
    // 与 pi 同源：跟随 PATH 里的 pi（systemd 服务用 /home/ubuntu/.local/bin/pi）
    this.piPath = options.piPath ?? "/home/ubuntu/.local/bin/pi";
  }

  /** 确保子进程存活（懒启动）。 */
  private ensureProc(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) {
      this.resetIdleTimer();
      return this.proc;
    }
    const args = ["--mode", "rpc", "--no-extensions"];
    // 只读桥共享主进程会话目录（export_html 等读同一批 session 文件）
    if (this.sessionDir) args.push("--session-dir", this.sessionDir);
    const proc = spawn(this.piPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = proc;
    this.buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        this.handleLine(line);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text) console.error(`${TAG} rpc-bridge stderr: ${text.slice(0, 300)}`);
    });
    proc.on("exit", (code) => {
      // 进程退出 → 所有 pending 拒绝
      for (const [, resolve] of this.pending) {
        resolve({ type: "response", command: "", success: false } as RpcResponse);
      }
      this.pending.clear();
      console.error(`${TAG} rpc-bridge exited (code=${code})`);
      this.proc = undefined;
    });
    this.resetIdleTimer();
    return proc;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return; // 非 JSON 行（协议噪声）忽略
    }
    if (parsed.type === "response" && parsed.id) {
      const resolve = this.pending.get(parsed.id);
      if (resolve) {
        this.pending.delete(parsed.id);
        resolve(parsed);
      }
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, this.idleMs);
  }

  /** 发送一条 RPC 命令并等待响应。 */
  async call<T = unknown>(command: string, payload?: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcResponse<T>> {
    const proc = this.ensureProc();
    const id = `rpc-${this.nextId++}`;
    const result = new Promise<RpcResponse>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ type: "response", id, command, success: false } as RpcResponse);
        }
      }, timeoutMs);
    });
    proc.stdin.write(JSON.stringify({ id, type: command, ...payload }) + "\n");
    const resp = await result;
    return resp as RpcResponse<T>;
  }

  /** 导出当前会话为 HTML（export_html）。返回导出路径；失败返回 undefined。 */
  async exportHtml(outputPath?: string): Promise<string | undefined> {
    const resp = await this.call<{ path?: string }>("export_html", outputPath ? { outputPath } : undefined);
    if (!resp.success || !resp.data?.path) return undefined;
    return resp.data.path;
  }

  /** 切换到指定 session 文件（只读桥：先 switch 到主进程会话再导出）。 */
  async switchSession(sessionPath: string): Promise<boolean> {
    const resp = await this.call<{ cancelled?: boolean }>("switch_session", { sessionPath });
    return resp.success && resp.data?.cancelled !== true;
  }

  /** 更新会话目录（captureCtx 后补填；只在未启动时生效）。 */
  setSessionDir(dir: string | undefined): void {
    this.sessionDir = dir;
  }

  /** 回收子进程（空闲超时 / 显式调用）。 */
  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null) {
      try {
        proc.stdin.end();
        proc.kill();
      } catch {
        // 已退出则忽略
      }
    }
  }
}

/** 找主进程当前 session 文件所在目录（供 RPC 桥 --session-dir）。 */
export function resolveSessionDirFromFile(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  const dir = sessionFile.split("/").slice(0, -1).join("/");
  return dir && existsSync(dir) ? dir : undefined;
}

/** 默认 pi 可执行文件路径（跟随 PATH）。 */
export function resolvePiBinary(): string {
  return "/home/ubuntu/.local/bin/pi";
}

/** 校验导出路径安全（在工作区内）。 */
export function isPathInsideWorkspace(target: string, cwd: string): boolean {
  const abs = target.startsWith("/") ? target : join(cwd, target);
  const cwdAbs = cwd.endsWith("/") ? cwd : cwd + "/";
  return abs.startsWith(cwdAbs);
}
