import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@shared/schema/chat";
import { lineOf, messageLine } from "./message-line";

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "00000000-0000-4000-8000-000000000001",
  seq: 1,
  kind: "text",
  authorId: null,
  text: null,
  notice: null,
  replyTo: null,
  forwardedFromId: null,
  mentions: [],
  reactions: [],
  poll: null,
  files: [],
  pinned: false,
  editedAt: null,
  deletedAt: null,
  deletedByOther: false,
  createdAt: "2026-10-07T12:00:00.000Z",
  ...over,
});

const photo = {
  fileId: "00000000-0000-4000-8000-000000000002",
} as ChatMessage["files"][number];

describe("the one line that says what a message is", () => {
  it("names a photo sent with no words, instead of calling it deleted", () => {
    // the bug: "Replying to Message deleted" over a reply to a picture (owner, 2026-10-07)
    expect(messageLine(message({ files: [photo] }))).toBe("File");
    expect(messageLine(message({ files: [photo, photo] }))).toBe("2 files");
  });

  it("puts the words beside the files, first line only and without the marks", () => {
    expect(messageLine(message({ text: "**Here** it is\nsecond", files: [photo] }))).toBe(
      "File · Here it is",
    );
    expect(messageLine(message({ text: "Which form?\nthe 1120" }))).toBe("Which form?");
  });

  it("says deleted only when it is", () => {
    expect(
      messageLine(message({ deletedAt: "2026-10-07T12:01:00.000Z", files: [photo] })),
    ).toBe("Message deleted");
    expect(lineOf({ deleted: true, kind: "text", words: null, files: 0 })).toBe(
      "Message deleted",
    );
  });

  it("calls a poll a poll", () => {
    expect(messageLine(message({ kind: "poll", text: "Friday or Monday?" }))).toBe(
      "Poll: Friday or Monday?",
    );
  });

  it("quotes a reply to a photo from the count the server sends", () => {
    expect(lineOf({ deleted: false, kind: "text", words: null, files: 1 })).toBe("File");
    expect(lineOf({ deleted: false, kind: "text", words: "Nice", files: 0 })).toBe("Nice");
  });
});
