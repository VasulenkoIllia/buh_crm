// The chat's cross-module surface (AGENTS.md, "Frontend rules"): only what other modules use.
export { useRealtime, reconnectRealtime, useChatPresence } from "./use-realtime";
// the shell keeps the live connection open and answers for the whole CRM (chat.md §10.1)
export { ChatWatch, useChatUnread } from "./chat-watch";
