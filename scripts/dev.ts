/**
 * `bun run dev`: the API server (with --watch) and the Vite dev server
 * together, with prefixed output. Open http://localhost:5173.
 * Ctrl+C stops both.
 */
const procs = [
  { name: "api", color: "\x1b[36m", cmd: ["bun", "--watch", "src/index.ts"], cwd: "apps/server" },
  { name: "web", color: "\x1b[35m", cmd: ["bunx", "vite"], cwd: "apps/web" },
].map(({ name, color, cmd, cwd }) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "1" } });
  const prefix = `${color}${name.padEnd(3)}\x1b[0m │ `;
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) console.log(prefix + line);
      }
    })();
  }
  void proc.exited.then((code) => {
    console.log(`${prefix}exited with ${code}`);
    shutdown(code ?? 1);
  });
  return proc;
});

let stopping = false;
function shutdown(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const proc of procs) proc.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
