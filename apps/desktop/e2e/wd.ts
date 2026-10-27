// Minimal W3C WebDriver client for driving the desktop app through
// tauri-driver (no extra dependencies).

const WD = process.env.E2E_WEBDRIVER ?? "http://127.0.0.1:4444";
/** Path of the app binary as seen by tauri-driver (inside WSL on Windows). */
const APP = process.env.E2E_APP ?? "";

type Json = Record<string, unknown>;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(WD + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json()) as { value: T & { error?: string; message?: string } };
  if (j.value && typeof j.value === "object" && "error" in j.value && j.value.error) {
    throw new Error(`WebDriver ${method} ${path}: ${j.value.error}: ${j.value.message}`);
  }
  return j.value;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class App {
  private readonly id: string;

  private constructor(id: string) {
    this.id = id;
  }

  /** Starts the app (a fresh process) and waits for the first page. */
  static async launch(): Promise<App> {
    if (!APP) throw new Error("Set E2E_APP to the app binary (run through e2e/run.mjs).");
    const s = await call<{ sessionId: string }>("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: APP } } },
    });
    const app = new App(s.sessionId);
    await app.waitFor(() => app.js<boolean>("return !!document.querySelector('h1')"), "the first page");
    return app;
  }

  private p(path: string) {
    return `/session/${this.id}${path}`;
  }

  async quit() {
    await call("DELETE", this.p("")).catch(() => {});
  }

  js<T>(script: string, ...args: unknown[]): Promise<T> {
    return call<T>("POST", this.p("/execute/sync"), { script, args });
  }

  /** Runs async code; the script calls `done(value)`. */
  jsAsync<T>(script: string, ...args: unknown[]): Promise<T> {
    return call<T>("POST", this.p("/execute/async"), {
      script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then(done, (e) => done({ __error: String(e) }));`,
      args,
    });
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(await call<string>("GET", this.p("/screenshot")), "base64");
  }

  async waitFor<T>(probe: () => Promise<T>, what: string, timeoutMs = 30_000): Promise<NonNullable<T>> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
      try {
        const v = await probe();
        if (v) return v as NonNullable<T>;
      } catch (e) {
        last = e;
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${what}${last ? ` (${String(last)})` : ""}`);
  }

  /** Navigates with the app's own links (client-side routing). */
  async goto(page: "edit" | "utilities" | "remove-bg" | "about") {
    await this.js(`document.querySelector('a[href="/${page}/"]').click()`);
    await this.waitFor(() => this.js<boolean>(`return location.pathname === "/${page}/"`), `/${page}/`);
  }

  private async element(css: string): Promise<string> {
    const v = await call<Json>("POST", this.p("/element"), { using: "css selector", value: css });
    return Object.values(v)[0] as string;
  }

  /** Puts files (paths on the app's machine) into the first file input. */
  async addFiles(...paths: string[]) {
    const el = await this.element('[data-testid="file-input"]');
    await call("POST", this.p(`/element/${el}/value`), { text: paths.join("\n") });
  }

  /** Clicks the first visible button, link, radio or switch whose accessible text matches. */
  async click(role: "button" | "radio" | "switch" | "link" | "option", name: string | RegExp) {
    const pattern = typeof name === "string" ? `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : name.source;
    const ok = await this.waitFor(
      () =>
        this.js<boolean>(
          `const re = new RegExp(arguments[1]);
           const sel = { button: 'button,[role=button]', radio: '[role=radio]', switch: '[role=switch]', link: 'a', option: '[role=option]' }[arguments[0]];
           const el = [...document.querySelectorAll(sel)].find((e) => {
             const label = (e.getAttribute('aria-label') || e.labels?.[0]?.textContent || e.textContent || '').trim();
             return re.test(label) && e.getClientRects().length > 0 && !e.disabled;
           });
           if (!el) return false;
           el.scrollIntoView({ block: 'center' });
           el.click();
           return true;`,
          role,
          pattern,
        ),
      `${role} "${String(name)}"`,
    );
    return ok;
  }

  /** Chooses an option in a labelled shadcn/Radix select. */
  async choose(label: string, option: string) {
    await this.js(
      `const l = [...document.querySelectorAll('label')].find((e) => e.textContent.trim() === arguments[0]);
       document.getElementById(l.htmlFor).click();`,
      label,
    );
    await this.click("option", option);
  }

  /** Moves a labelled slider with the keyboard (Radix sliders react to arrow keys). */
  async setSlider(label: string, steps: number) {
    await this.js(`document.querySelector('[role=slider][aria-label="' + arguments[0] + '"]').focus()`, label);
    const key = steps > 0 ? "" : ""; // ArrowRight / ArrowLeft
    const actions = Array.from({ length: Math.abs(steps) }, () => [
      { type: "keyDown", value: key },
      { type: "keyUp", value: key },
    ]).flat();
    await call("POST", this.p("/actions"), { actions: [{ type: "key", id: "kb", actions }] });
  }

  text(css: string): Promise<string | null> {
    return this.js<string | null>(`return document.querySelector(arguments[0])?.textContent ?? null`, css);
  }

  /** Error messages currently shown (alerts). */
  errors(): Promise<string> {
    return this.js<string>(`return [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent).filter(Boolean).join(' | ')`);
  }
}
