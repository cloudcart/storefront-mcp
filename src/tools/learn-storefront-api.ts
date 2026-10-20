import { randomUUID } from "node:crypto";
import { STOREFRONT_GUIDE } from "../prompts/storefront.js";

export interface LearnApiInput {
  conversationId?: string;
  model?: string;
}

export function learnStorefrontApi(input: LearnApiInput) {
  const conversationId = input.conversationId ?? randomUUID();

  const text = `**SAVE THIS CONVERSATION ID:** ${conversationId}
Pass it to every other CloudCart Storefront tool call in this conversation.
---
${STOREFRONT_GUIDE}`;

  return {
    content: [{ type: "text" as const, text }],
  };
}
