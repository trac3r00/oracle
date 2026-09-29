import type { ChromeClient, BrowserLogger } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { delay } from "../utils.js";

// ChatGPT (2026-09): the composer's "+" button opens a floating list of tools. Native tools
// (Create image, Web search, Sketch, Deep research, ...) and plugins/connectors share one row
// shape; a native row names itself in its first text span, a connector row in the leading words.
export const COMPOSER_PLUS_BUTTON_SELECTOR =
  'button[aria-label="Add files and more"], #composer-plus-btn, button[data-testid="composer-plus-btn"]';
const TOOL_ROW_SELECTOR =
  '[data-composer-overlay-floating-ui="true"] button[data-list-navigation-item="true"]';

export interface ComposerToolListing {
  status: "clicked" | "missing" | "no-menu";
  available: string[];
}

export function buildHasComposerToolMenuExpression(): string {
  return `Boolean(document.querySelector('button[aria-label="Add files and more"]'))`;
}

export function buildClickComposerToolExpression(title: string): string {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const target = norm(${JSON.stringify(title)});
    const rowTitle = (row) => {
      const leaf = Array.from(row.querySelectorAll('span'))
        .find((span) => span.childElementCount === 0 && span.textContent.trim());
      return (leaf?.textContent ?? row.textContent ?? '').replace(/\\s+/g, ' ').trim();
    };
    const matches = (row) => {
      const name = norm(rowTitle(row));
      return name === target || name.startsWith(target + ' ');
    };
    const plus = document.querySelector(${JSON.stringify(COMPOSER_PLUS_BUTTON_SELECTOR)});
    if (!plus) return { status: 'no-menu', available: [] };
    let rows = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      rows = Array.from(document.querySelectorAll(${JSON.stringify(TOOL_ROW_SELECTOR)}));
      if (rows.length > 0) break;
      if (attempt % 10 === 0 && plus.getAttribute('aria-expanded') !== 'true') {
        plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        plus.click();
      }
      await sleep(100);
    }
    const available = rows.map(rowTitle).filter(Boolean);
    const row = rows.find(matches);
    if (!row) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { status: rows.length ? 'missing' : 'no-menu', available };
    }
    row.click();
    return { status: 'clicked', available };
  })()`;
}

export function buildComposerToolActiveExpression(title: string): string {
  return `(() => {
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const target = norm(${JSON.stringify(title)});
    const chip = Array.from(document.querySelectorAll('button[aria-label^="Remove "]'))
      .some((node) => norm(node.getAttribute('aria-label').slice('Remove '.length)) === target);
    const editor = document.querySelector('.ProseMirror');
    const mention = Array.from(editor?.querySelectorAll('[app-mention-display-name], [app-mention-name]') ?? [])
      .some((node) => norm(node.getAttribute('app-mention-display-name')) === target ||
        norm(node.getAttribute('app-mention-name')) === target.replace(/ /g, '-'));
    return chip || mention;
  })()`;
}

async function evaluateValue<T>(runtime: ChromeClient["Runtime"], expression: string): Promise<T> {
  const { result, exceptionDetails } = await runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new BrowserAutomationError(
      `ChatGPT composer tool script failed: ${exceptionDetails.text ?? "unknown error"}`,
      { stage: "composer-tool" },
    );
  }
  return result?.value as T;
}

async function waitFor(
  runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await evaluateValue<boolean>(runtime, expression)) === true) return true;
    if (Date.now() >= deadline) return false;
    await delay(150);
  }
}

async function clickComposerTool(runtime: ChromeClient["Runtime"], title: string): Promise<void> {
  const listing = await evaluateValue<ComposerToolListing>(
    runtime,
    buildClickComposerToolExpression(title),
  );
  if (listing?.status === "clicked") return;
  const available = listing?.available?.length
    ? ` Available: ${listing.available.join(", ")}.`
    : "";
  throw new BrowserAutomationError(
    listing?.status === "no-menu"
      ? `ChatGPT's composer tool menu ("+") did not open; "${title}" was not activated and nothing was sent.`
      : `ChatGPT composer tool "${title}" is not available for this account.${available}`,
    {
      stage: "composer-tool",
      code: listing?.status === "no-menu" ? "composer-tool-menu-missing" : "composer-tool-missing",
      tool: title,
      available: listing?.available ?? [],
    },
  );
}

export async function activateComposerTool(
  runtime: ChromeClient["Runtime"],
  title: string,
  logger: BrowserLogger,
): Promise<void> {
  const active = buildComposerToolActiveExpression(title);
  if (await evaluateValue<boolean>(runtime, active)) {
    logger(`Composer tool already active: ${title}`);
    return;
  }
  await clickComposerTool(runtime, title);
  if (!(await waitFor(runtime, active, 5_000))) {
    throw new BrowserAutomationError(
      `ChatGPT composer tool "${title}" was clicked but its chip or mention never appeared; nothing was sent.`,
      { stage: "composer-tool", code: "composer-tool-unverified", tool: title },
    );
  }
  logger(`Composer tool activated: ${title}`);
}

function buildLibraryMentionExpression(name: string): string {
  return `(() => {
    const target = ${JSON.stringify(name)}.trim().toLowerCase();
    const editor = document.querySelector('.ProseMirror');
    return Array.from(editor?.querySelectorAll('[chatgpt-library-file-mention-title]') ?? [])
      .some((node) => {
        const title = String(node.getAttribute('chatgpt-library-file-mention-title')).trim().toLowerCase();
        return title === target || title.replace(/\\.[^.]+$/, '') === target;
      });
  })()`;
}

function buildLibraryPickExpression(name: string): string {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const target = ${JSON.stringify(name)}.trim().toLowerCase();
    const dialog = () => Array.from(document.querySelectorAll('[role="dialog"]'))
      .find((node) => node.querySelector('input[placeholder="Search library"]'));
    let root = null;
    for (let i = 0; i < 50 && !root; i += 1) { root = dialog(); if (!root) await sleep(100); }
    if (!root) return { status: 'no-dialog', available: [] };
    const search = root.querySelector('input[placeholder="Search library"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, ${JSON.stringify(name)});
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const label = (button) => String(button.getAttribute('aria-label') ?? '').split(',')[0].trim().toLowerCase();
    const isFile = (button) => {
      const value = label(button);
      return value && !value.startsWith('select ') && !['grid view', 'filter library sources', 'close'].includes(value);
    };
    let file = null;
    let files = [];
    for (let i = 0; i < 60 && !file; i += 1) {
      await sleep(150);
      files = Array.from((dialog() ?? root).querySelectorAll('button[aria-label]')).filter(isFile);
      file = files.find((button) => label(button) === target || label(button).replace(/\\.[^.]+$/, '') === target);
    }
    const available = Array.from(new Set(files.map((button) => button.getAttribute('aria-label'))));
    if (!file) return { status: 'missing', available };
    file.click();
    let add = null;
    for (let i = 0; i < 40 && !add; i += 1) {
      await sleep(100);
      add = Array.from((dialog() ?? root).querySelectorAll('button'))
        .find((button) => button.textContent.trim() === 'Add to chat' && !button.disabled);
    }
    if (!add) return { status: 'no-add', available };
    add.click();
    return { status: 'added', available };
  })()`;
}

function buildCloseDialogExpression(): string {
  return `(() => {
    for (const button of document.querySelectorAll('[role="dialog"] button')) {
      const label = button.getAttribute('aria-label') ?? button.textContent.trim();
      if (label === 'Close' || label === 'Close sketch editor') { button.click(); return true; }
    }
    return false;
  })()`;
}

export async function attachLibraryFiles(
  runtime: ChromeClient["Runtime"],
  names: readonly string[],
  logger: BrowserLogger,
): Promise<void> {
  for (const name of names) {
    const mention = buildLibraryMentionExpression(name);
    if (await evaluateValue<boolean>(runtime, mention)) continue;
    await clickComposerTool(runtime, "Add library files");
    const picked = await evaluateValue<{ status: string; available: string[] }>(
      runtime,
      buildLibraryPickExpression(name),
    );
    if (picked?.status !== "added") {
      await evaluateValue(runtime, buildCloseDialogExpression());
      const matches = picked?.available?.length
        ? ` Library matches: ${picked.available.slice(0, 15).join(", ")}.`
        : "";
      throw new BrowserAutomationError(
        `ChatGPT library file "${name}" could not be attached (${picked?.status ?? "unknown"}); nothing was sent.${matches}`,
        { stage: "library-file", code: `library-file-${picked?.status ?? "unknown"}`, file: name },
      );
    }
    if (!(await waitFor(runtime, mention, 8_000))) {
      throw new BrowserAutomationError(
        `ChatGPT library file "${name}" was added but never appeared in the composer; nothing was sent.`,
        { stage: "library-file", code: "library-file-unverified", file: name },
      );
    }
    logger(`Library file attached: ${name}`);
  }
}

/**
 * Parses a sketch spec: strokes separated by ";", each a list of "x,y" points in 0..1 of the
 * canvas, e.g. "0.1,0.1 0.9,0.9; 0.1,0.9 0.9,0.1" draws an X.
 */
export function parseSketchSpec(spec: string): Array<Array<{ x: number; y: number }>> {
  const strokes = spec
    .split(";")
    .map((stroke) =>
      stroke
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((point) => {
          const [x, y] = point.split(",").map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
            throw new Error(`Invalid sketch point "${point}": expected x,y between 0 and 1.`);
          }
          return { x, y };
        }),
    )
    .filter((stroke) => stroke.length > 0);
  if (strokes.length === 0 || strokes.some((stroke) => stroke.length < 2)) {
    throw new Error('Sketch needs at least one stroke of two or more "x,y" points.');
  }
  return strokes;
}

export async function attachSketch(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"],
  spec: string,
  logger: BrowserLogger,
): Promise<void> {
  const strokes = parseSketchSpec(spec);
  const composerFiles = `document.querySelectorAll('.ProseMirror img, [data-testid*="attachment"], [data-testid*="file-tile"], img[alt]').length`;
  const before = await evaluateValue<number>(runtime, composerFiles);
  await clickComposerTool(runtime, "Sketch");
  const rectExpression = `(() => {
    const canvas = document.querySelector('[role="dialog"] canvas[aria-label="Sketch canvas"]');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null;
  })()`;
  let rect: { x: number; y: number; w: number; h: number } | null = null;
  const deadline = Date.now() + 5_000;
  while (!rect && Date.now() < deadline) {
    rect = await evaluateValue(runtime, rectExpression);
    if (!rect) await delay(150);
  }
  if (!rect) {
    throw new BrowserAutomationError("ChatGPT's Sketch editor did not open; nothing was sent.", {
      stage: "sketch",
      code: "sketch-editor-missing",
    });
  }
  const at = (point: { x: number; y: number }) => ({
    x: rect!.x + point.x * rect!.w,
    y: rect!.y + point.y * rect!.h,
  });
  for (const stroke of strokes) {
    const first = at(stroke[0]);
    await input.dispatchMouseEvent({ type: "mouseMoved", ...first });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      ...first,
      button: "left",
      clickCount: 1,
    });
    for (let index = 1; index < stroke.length; index += 1) {
      const from = at(stroke[index - 1]);
      const to = at(stroke[index]);
      for (let step = 1; step <= 8; step += 1) {
        await input.dispatchMouseEvent({
          type: "mouseMoved",
          x: from.x + ((to.x - from.x) * step) / 8,
          y: from.y + ((to.y - from.y) * step) / 8,
          button: "left",
          buttons: 1,
        });
      }
    }
    const last = at(stroke[stroke.length - 1]);
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      ...last,
      button: "left",
      clickCount: 1,
    });
  }
  const submitted = await evaluateValue<boolean>(
    runtime,
    `(() => {
      const button = Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find((node) => node.getAttribute('aria-label') === 'Attach sketch' || node.textContent.trim() === 'Attach sketch');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
  const attached =
    submitted &&
    (await waitFor(
      runtime,
      `!document.querySelector('[role="dialog"] canvas[aria-label="Sketch canvas"]') && (${composerFiles}) > ${before}`,
      15_000,
    ));
  if (!attached) {
    await evaluateValue(runtime, buildCloseDialogExpression());
    throw new BrowserAutomationError(
      "ChatGPT's Sketch could not be attached (Attach sketch unavailable or no attachment appeared); nothing was sent.",
      { stage: "sketch", code: "sketch-not-attached" },
    );
  }
  const sendReady = await waitFor(
    runtime,
    `(() => {
      const button = document.querySelector('button[data-testid="send-button"], button[aria-label="Send"]');
      return Boolean(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    })()`,
    30_000,
  );
  if (!sendReady) {
    throw new BrowserAutomationError(
      "ChatGPT's sketch upload never finished (Send stayed disabled); nothing was sent.",
      { stage: "sketch", code: "sketch-upload-unfinished" },
    );
  }
  logger(`Sketch attached (${strokes.length} stroke${strokes.length === 1 ? "" : "s"})`);
}
