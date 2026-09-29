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
 */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const unitSelector = JSON.stringify(MESSAGE_UNIT_SELECTOR);
  return `(() => {
    const root = ${rootExpression};
    const containers = Array.from(root.querySelectorAll(${containerSelector}));
    if (containers.length > 0) return containers;
    const units = [];
    for (const unit of Array.from(root.querySelectorAll(${unitSelector}))) {
      const key = unit.getAttribute('data-content-search-unit-key') || '';
      const role = /(?:^|[:_-])(user|assistant)$/.exec(key)?.[1];
      if (!role) continue;
      if (unit.getAttribute('data-message-author-role') !== role) {
        unit.setAttribute('data-message-author-role', role);
      }
      if (unit.getAttribute('data-message-id') !== key) unit.setAttribute('data-message-id', key);
      units.push(unit);
    }
    if (units.length > 0) return units;
    return Array.from(root.querySelectorAll(${fallbackSelector}));
  })()`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}
