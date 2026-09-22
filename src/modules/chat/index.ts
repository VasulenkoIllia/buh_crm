// The chat's cross-module surface (AGENTS.md, "Frontend rules"): only what other modules use.
export { useRealtime, reconnectRealtime, useChatPresence } from "./use-realtime";
// the shell keeps the live connection open and answers for the whole CRM (chat.md §10.1)
export { ChatWatch, useChatUnread } from "./chat-watch";
/**
 * **What every chat is holding** (chat.md §6.5), for the Chats pane on the FILES screen. Hooks
 * only, no component: the pane is drawn with Files' own frame, and the data is the chat's.
 * `useChatFiles` is the same read the chat's own Files tab uses, so opening a chat in the pane
 * costs nothing new.
 */
export { useChatFiles, useChatFilesOverview, useKeepChatFile } from "./chat.api";
