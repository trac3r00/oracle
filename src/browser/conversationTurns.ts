import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  MESSAGE_UNIT_SELECTOR,
} from "./constants.js";

/**
 * Build a browser-context expression that returns one DOM node per conversation turn.
 *
 * Current ChatGPT renders each message as a `[data-content-search-unit-key$=":user"|":assistant"]`
 * unit (a user and an assistant unit can share one `div[data-turn-key]` wrapper) without the
 * legacy `data-message-author-role` / `data-message-id` attributes. Those units are returned as
 * turns and tagged with the legacy attributes, so every role-based reader keeps working. The unit
 * key is the message identity: it stays stable while the answer streams and across re-renders.
 * Image-only answers have no unit; their `[data-chatgpt-search-message-ids]` container is the
 * assistant turn, identified by its message id.
 */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const unitSelector = JSON.stringify(MESSAGE_UNIT_SELECTOR);
  return `(() => {
    const root = ${rootExpression};
    const containers = Array.from(root.querySelectorAll(${containerSelector}));
    if (containers.length > 0) return containers;
    const unitSelector = ${unitSelector};
    const tag = (node, role, id) => {
      if (node.getAttribute('data-message-author-role') !== role) {
        node.setAttribute('data-message-author-role', role);
      }
      if (node.getAttribute('data-message-id') !== id) node.setAttribute('data-message-id', id);
    };
    const units = [];
    for (const node of Array.from(root.querySelectorAll(unitSelector))) {
      const key = node.getAttribute('data-content-search-unit-key') || '';
      const role = /(?:^|[:_-])(user|assistant)$/.exec(key)?.[1];
      if (!role) continue;
      tag(node, role, key);
      units.push(node);
    }
    const imageOnly = [];
    for (const node of Array.from(root.querySelectorAll('[data-chatgpt-search-message-ids]'))) {
      if (node.hasAttribute?.('data-content-search-unit-key')) continue;
      if (node.closest?.(unitSelector) || node.querySelector?.(unitSelector)) continue;
      const messageId = String(node.getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/\\s+/)[0];
      if (!messageId) continue;
      tag(node, 'assistant', 'message:' + messageId);
      imageOnly.push(node);
    }
    if (imageOnly.length > 0) {
      units.push(...imageOnly);
      units.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    }
    if (units.length > 0) return units;
    return Array.from(root.querySelectorAll(${fallbackSelector}));
  })()`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}
