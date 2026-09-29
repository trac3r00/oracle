import { describe, expect, test, vi } from "vitest";
import {
  buildConversationTurnCountExpression,
  buildConversationTurnListExpression,
} from "../../src/browser/conversationTurns.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  MESSAGE_UNIT_SELECTOR,
} from "../../src/browser/constants.js";

function evaluate(expression: string, responses: Map<string, unknown[]>): unknown {
  const document = {
    querySelectorAll: vi.fn((selector: string) => responses.get(selector) ?? []),
  };
  return Function("document", `return ${expression};`)(document);
}

describe("conversation turn expressions", () => {
  test("prefers top-level turn containers over nested broad-selector matches", () => {
    const containers = [{ id: "user" }, { id: "assistant" }];
    const nestedMatches = [...containers, { id: "nested-assistant" }];
    const responses = new Map([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, containers],
      [CONVERSATION_TURN_SELECTOR, nestedMatches],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual(containers);
    expect(evaluate(buildConversationTurnCountExpression(), responses)).toBe(2);
  });

  test("falls back to the broad selector for older conversation markup", () => {
    const legacyTurns = [{ id: "user" }, { id: "assistant" }];
    const responses = new Map([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, []],
      [CONVERSATION_TURN_SELECTOR, legacyTurns],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual(legacyTurns);
  });

  test("returns current message units as role-tagged turns", () => {
    const unit = (key: string) => {
      const attributes = new Map([["data-content-search-unit-key", key]]);
      return {
        attributes,
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      };
    };
    // One div[data-turn-key] wrapper holds both messages; the search unit is not a message.
    const user = unit("fallback-turn-0:0:user");
    const assistant = unit("fallback-turn-0:2:assistant");
    const search = unit("fallback-turn-0:1:search");
    const legacyTurns = [{ id: "stale-legacy-match" }];
    const responses = new Map<string, unknown[]>([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, []],
      [MESSAGE_UNIT_SELECTOR, [user, search, assistant]],
      [CONVERSATION_TURN_SELECTOR, legacyTurns],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual([user, assistant]);
    expect(user.attributes.get("data-message-author-role")).toBe("user");
    expect(user.attributes.get("data-message-id")).toBe("fallback-turn-0:0:user");
    expect(assistant.attributes.get("data-message-author-role")).toBe("assistant");
    expect(assistant.attributes.get("data-message-id")).toBe("fallback-turn-0:2:assistant");
    expect(search.attributes.has("data-message-author-role")).toBe(false);
  });

  test("returns an image-only answer container as the assistant turn", () => {
    const node = (attributes: Map<string, string>, order: number) => ({
      order,
      attributes,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      hasAttribute: (name: string) => attributes.has(name),
      closest: () => null,
      querySelector: () => null,
      compareDocumentPosition(other: { order: number }) {
        return other.order > order ? 4 : 2;
      },
    });
    const user = node(new Map([["data-content-search-unit-key", "fallback-turn-0:0:user"]]), 0);
    const image = node(new Map([["data-chatgpt-search-message-ids", "msg-1 msg-1"]]), 1);
    const responses = new Map<string, unknown[]>([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, []],
      [MESSAGE_UNIT_SELECTOR, [user]],
      ["[data-chatgpt-search-message-ids]", [image]],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual([user, image]);
    expect(image.attributes.get("data-message-author-role")).toBe("assistant");
    expect(image.attributes.get("data-message-id")).toBe("message:msg-1");
  });
});
