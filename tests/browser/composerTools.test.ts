import { describe, expect, test } from "vitest";
import {
  buildClickComposerToolExpression,
  parseSketchSpec,
} from "../../src/browser/actions/composerTools.js";

describe("composer tools", () => {
  test("parses normalized sketch strokes", () => {
    expect(parseSketchSpec("0.1,0.1 0.9,0.9; 0.1,0.9 0.9,0.1")).toEqual([
      [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
      [
        { x: 0.1, y: 0.9 },
        { x: 0.9, y: 0.1 },
      ],
    ]);
    expect(() => parseSketchSpec("0.5,0.5")).toThrow(/two or more/);
    expect(() => parseSketchSpec("0,0 1.5,0.2")).toThrow(/between 0 and 1/);
  });

  test("clicks a native or connector row by its name and lists the rest", async () => {
    const row = (title: string, description?: string) => {
      const spans = description
        ? [
            { childElementCount: 0, textContent: title },
            { childElementCount: 0, textContent: description },
          ]
        : [{ childElementCount: 0, textContent: title }];
      return {
        clicked: false,
        textContent: title + (description ?? ""),
        querySelectorAll: () => spans,
        click() {
          this.clicked = true;
        },
      };
    };
    const image = row("Create image", "Visualize anything");
    const github = row("GitHub Triage PRs, issues, CI, and publish flows");
    const plus = { getAttribute: () => "true", dispatchEvent: () => true, click: () => undefined };
    const document = {
      querySelector: () => plus,
      querySelectorAll: () => [image, github],
      dispatchEvent: () => true,
    };
    const run = (title: string) =>
      new Function(
        "document",
        "setTimeout",
        "KeyboardEvent",
        `return ${buildClickComposerToolExpression(title)}`,
      )(document, setTimeout, class {}) as Promise<{ status: string; available: string[] }>;

    await expect(run("github")).resolves.toMatchObject({ status: "clicked" });
    expect(github.clicked).toBe(true);
    expect(image.clicked).toBe(false);
    await expect(run("Sketch")).resolves.toEqual({
      status: "missing",
      available: ["Create image", "GitHub Triage PRs, issues, CI, and publish flows"],
    });
  });
});
