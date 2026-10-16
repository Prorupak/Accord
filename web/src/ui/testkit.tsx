// Test-only DOM helpers for the UI: render with React's own act, find controls by their visible
// text, and stub the browser APIs jsdom lacks. Everything below the DOM is the real app.
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import type { HttpResult } from "../analysis/response";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<StrictMode>{node}</StrictMode>));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// Lets async work (file reads, hashing, fetch) finish and React commit the results.
export const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  });

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

export function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement {
  const all = [...root.querySelectorAll("button")];
  const found = all.find((b) => (typeof name === "string" ? text(b) === name : name.test(text(b))));
  if (!found) throw new Error(`no button ${name}; have: ${all.map(text).join(" | ")}`);
  return found;
}

export const queryButton = (name: string | RegExp, root: ParentNode = document) => {
  try {
    return button(name, root);
  } catch {
    return null;
  }
};

export const pageText = () => text(document.body);

export async function click(el: HTMLElement) {
  act(() => el.click());
  await settle();
}

export function select(id: string, value: string) {
  const el = document.getElementById(id) as HTMLSelectElement;
  if (!el) throw new Error(`no select #${id}`);
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function checkbox(label: string): HTMLInputElement {
  const l = [...document.querySelectorAll("label")].find((x) => text(x).includes(label));
  const input = l?.querySelector("input");
  if (!input) throw new Error(`no checkbox ${label}`);
  return input;
}

export function chooseFiles(side: "A" | "B", file: File) {
  const input = document.getElementById(`source-${side}-file`) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export const csvFile = (name: string, content: string | Uint8Array) => new File([content as BlobPart], name, { type: "text/csv" });

// The review queue row (a button) whose text contains `needle`; clicking it opens the inspector.
export function rowWith(needle: string): HTMLButtonElement {
  const row = [...document.querySelectorAll("#review-queue button")].find((r) => text(r).includes(needle));
  if (!row) throw new Error(`no row containing ${needle}`);
  return row as HTMLButtonElement;
}

export const details = (needle: string) => click(rowWith(needle));

// The <dd> following a <dt> with this label in the summary.
export function count(label: string): number {
  const dt = [...document.querySelectorAll("dt")].find((d) => text(d) === label);
  return Number(dt?.nextElementSibling?.textContent);
}

// A fetch stub for same-origin API routes. Unhandled routes fail the test loudly.
export function stubFetch(routes: Record<string, (body: string) => HttpResult | Promise<HttpResult>>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url, body });
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    const r = await handler(body);
    return { status: r.status, text: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

// Records every Blob handed to URL.createObjectURL so downloads can be read back.
export function stubObjectUrls() {
  const live = new Map<string, Blob>();
  const revoked: string[] = [];
  let n = 0;
  const api = {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:test/${++n}`;
      live.set(url, blob);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
      live.delete(url);
    }),
  };
  Object.assign(URL, api);
  return { live, revoked, api };
}
