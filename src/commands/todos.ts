// Todos bridge — 方案二：/todos 本地实现（笔记 26）。
// 背景：pi 的 /todos 是 TUI 交互界面（pi-agent-extensions/extensions/todos），
// Discord 远程调用缺少 UI mode 无法显示 → 桥接层直接读写 .pi/todos/<id>.md
// （JSON front matter + markdown body，与扩展同一存储格式，双向兼容）。
// 零依赖：node:fs。todo 目录 = PI_TODO_PATH env 或 <cwd>/.pi/todos。
import { randomBytes } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
/** 与扩展一致的 lock 文件 TTL（30 分钟）。 */
const LOCK_TTL_MS = 30 * 60 * 1000;

export interface TodoRecord {
  id: string;
  title: string;
  tags: string[];
  status: string;
  created_at: string;
  assigned_to_session?: string;
  body: string;
}

export function getTodosDir(cwd: string): string {
  const override = process.env[TODO_PATH_ENV]?.trim();
  if (override) return path.resolve(cwd, override);
  return path.resolve(cwd, TODO_DIR_NAME);
}

function isTodoClosed(status: string): boolean {
  return ["closed", "done"].includes((status ?? "").toLowerCase());
}

function normalizeTodoId(id: string): string {
  let trimmed = id.trim();
  if (trimmed.startsWith("#")) trimmed = trimmed.slice(1);
  if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
    trimmed = trimmed.slice(TODO_ID_PREFIX.length);
  }
  return trimmed;
}

function formatTodoId(id: string): string {
  return `${TODO_ID_PREFIX}${id}`;
}

/** JSON front matter + body 分离（与扩展 splitFrontMatter 同语义）。 */
function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  if (!content.startsWith("{")) return { frontMatter: "", body: content };
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { depth += 1; continue; }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) { endIndex = i; break; }
    }
  }
  if (endIndex === -1) return { frontMatter: "", body: content };
  return {
    frontMatter: content.slice(0, endIndex + 1),
    body: content.slice(endIndex + 1).replace(/^\r?\n+/, ""),
  };
}

function parseTodoContent(content: string, idFallback: string): TodoRecord {
  const { frontMatter, body } = splitFrontMatter(content);
  const todo: TodoRecord = {
    id: idFallback,
    title: "",
    tags: [],
    status: "open",
    created_at: "",
    body: body ?? "",
  };
  try {
    const parsed = JSON.parse(frontMatter || "{}") as Partial<TodoRecord> | null;
    if (parsed) {
      if (typeof parsed.id === "string" && parsed.id) todo.id = parsed.id;
      if (typeof parsed.title === "string") todo.title = parsed.title;
      if (typeof parsed.status === "string" && parsed.status) todo.status = parsed.status;
      if (typeof parsed.created_at === "string") todo.created_at = parsed.created_at;
      if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
        todo.assigned_to_session = parsed.assigned_to_session;
      }
      if (Array.isArray(parsed.tags)) {
        todo.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
      }
    }
  } catch { /* 保留默认值 */ }
  return todo;
}

function serializeTodo(todo: TodoRecord): string {
  const frontMatter = JSON.stringify(
    {
      id: todo.id,
      title: todo.title,
      tags: todo.tags ?? [],
      status: todo.status,
      created_at: todo.created_at,
      assigned_to_session: todo.assigned_to_session || undefined,
    },
    null,
    2,
  );
  const trimmedBody = (todo.body ?? "").replace(/^\n+/, "").replace(/\s+$/, "");
  if (!trimmedBody) return `${frontMatter}\n`;
  return `${frontMatter}\n\n${trimmedBody}\n`;
}

function sortTodos(todos: TodoRecord[]): TodoRecord[] {
  return [...todos].sort((a, b) => {
    const aClosed = isTodoClosed(a.status);
    const bClosed = isTodoClosed(b.status);
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    const aAssigned = !aClosed && Boolean(a.assigned_to_session);
    const bAssigned = !bClosed && Boolean(b.assigned_to_session);
    if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
}

async function listTodos(todosDir: string): Promise<TodoRecord[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(todosDir);
  } catch {
    return [];
  }
  const todos: TodoRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    try {
      const content = await readFile(path.join(todosDir, entry), "utf8");
      todos.push(parseTodoContent(content, id));
    } catch { /* 忽略不可读 */ }
  }
  return sortTodos(todos);
}

/** 按 id（TODO-xxxx 或裸 hex）或 1-based 序号解析。 */
async function resolveTodo(_todosDir: string, todos: TodoRecord[], ref: string): Promise<TodoRecord | undefined> {
  const normalized = normalizeTodoId(ref);
  if (TODO_ID_PATTERN.test(normalized)) {
    const byId = todos.find((t) => t.id.toLowerCase() === normalized.toLowerCase());
    if (byId) return byId;
  }
  const index = Number.parseInt(ref, 10);
  if (Number.isInteger(index) && index >= 1 && index <= todos.length) {
    return todos[index - 1];
  }
  return undefined;
}

async function ensureLockSafe(todosDir: string, id: string): Promise<boolean> {
  // 与 TUI 的 .lock 互斥：lock 存在且未过期 → 拒绝写（避免覆盖 TUI 正在编辑的 todo）
  const lockPath = path.join(todosDir, `${id}.lock`);
  if (!existsSync(lockPath)) return true;
  try {
    const stat = await readFile(lockPath, "utf8");
    const lock = JSON.parse(stat || "{}") as { acquired_at?: string };
    const ageMs = Date.now() - new Date(lock.acquired_at ?? 0).getTime();
    if (Number.isFinite(ageMs) && ageMs < LOCK_TTL_MS) return false;
  } catch { /* 无法解析 → 视为过期 */ }
  return true;
}

export async function generateTodoId(todosDir: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = randomBytes(4).toString("hex");
    if (!existsSync(path.join(todosDir, `${id}.md`))) return id;
  }
  return randomBytes(4).toString("hex");
}

// ---- 命令动作（全部返回 Discord 文本回复）----

export async function todosList(cwd: string): Promise<string> {
  const todosDir = getTodosDir(cwd);
  const todos = await listTodos(todosDir);
  if (todos.length === 0) {
    return "📋 **任务列表**：空（/todos add <标题> 新建）";
  }
  const lines = todos.map((t, i) => {
    const icon = isTodoClosed(t.status) ? "✅" : "⬜";
    const tags = t.tags.length ? ` \`#${t.tags.join(" #")}\`` : "";
    const assign = t.assigned_to_session ? ` 📍${t.assigned_to_session}` : "";
    return `${i + 1}. ${icon} ${t.title} — ${formatTodoId(t.id)}${tags}${assign}`;
  });
  return ["📋 **任务列表**（\`/todos done <序号|id>\` 完成）：", ...lines].join("\n");
}

export async function todosAdd(cwd: string, title: string): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) return "❌ 用法：/todos add <标题>";
  const todosDir = getTodosDir(cwd);
  await mkdir(todosDir, { recursive: true });
  const id = await generateTodoId(todosDir);
  const todo: TodoRecord = {
    id,
    title: trimmed,
    tags: [],
    status: "open",
    created_at: new Date().toISOString(),
    body: "",
  };
  await writeFile(path.join(todosDir, `${id}.md`), serializeTodo(todo), { encoding: "utf8", mode: 0o600 });
  return `✅ 已创建任务 ${formatTodoId(id)}：${trimmed}`;
}

export async function todosSetStatus(cwd: string, ref: string, status: "closed" | "open"): Promise<string> {
  const todosDir = getTodosDir(cwd);
  const todos = await listTodos(todosDir);
  const todo = await resolveTodo(todosDir, todos, ref);
  if (!todo) return `❌ 未找到任务：${ref}（/todos 查看列表）`;
  if (!(await ensureLockSafe(todosDir, todo.id))) {
    return `⏳ 任务 ${formatTodoId(todo.id)} 正在终端 TUI 中被编辑，请稍后再试。`;
  }
  const next: TodoRecord = { ...todo, status, assigned_to_session: status === "closed" ? undefined : todo.assigned_to_session };
  await writeFile(path.join(todosDir, `${todo.id}.md`), serializeTodo(next), { encoding: "utf8", mode: 0o600 });
  const verb = status === "closed" ? "✅ 已完成" : "🔄 已重新打开";
  return `${verb}：${todo.title}（${formatTodoId(todo.id)}）`;
}

export async function todosShow(cwd: string, ref: string): Promise<string> {
  const todosDir = getTodosDir(cwd);
  const todos = await listTodos(todosDir);
  const todo = await resolveTodo(todosDir, todos, ref);
  if (!todo) return `❌ 未找到任务：${ref}（/todos 查看列表）`;
  const lines = [
    `📌 **${todo.title}**`,
    `🆔 ${formatTodoId(todo.id)} · 状态 ${isTodoClosed(todo.status) ? "✅ closed" : "⬜ open"} · 📅 ${(todo.created_at ?? "").slice(0, 10)}`,
    ...(todo.tags.length ? [`🏷️ ${todo.tags.map((t) => `#${t}`).join(" ")}`] : []),
    ...(todo.assigned_to_session ? [`📍 会话：${todo.assigned_to_session}`] : []),
    ...(todo.body?.trim() ? ["```", todo.body.trim().slice(0, 1500), "```"] : []),
  ];
  return lines.join("\n");
}

export async function todosDelete(cwd: string, ref: string): Promise<string> {
  const todosDir = getTodosDir(cwd);
  const todos = await listTodos(todosDir);
  const todo = await resolveTodo(todosDir, todos, ref);
  if (!todo) return `❌ 未找到任务：${ref}（/todos 查看列表）`;
  if (!(await ensureLockSafe(todosDir, todo.id))) {
    return `⏳ 任务 ${formatTodoId(todo.id)} 正在终端 TUI 中被编辑，请稍后再试。`;
  }
  const { rm } = await import("node:fs/promises");
  await rm(path.join(todosDir, `${todo.id}.md`), { force: true });
  return `🗑️ 已删除任务：${todo.title}（${formatTodoId(todo.id)}）`;
}
