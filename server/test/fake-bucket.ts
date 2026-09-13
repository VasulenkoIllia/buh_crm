import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { s3Store } from "../core/files.js";

/**
 * A bucket in memory: it answers the four commands core/files.ts sends, and remembers them.
 *
 * `damage` flips the last byte of every object it hands back — what a failing disk or a bad
 * connection would do — while what it keeps stays as it was sent.
 */
export function fakeBucket(options: { damage?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const sent: unknown[] = [];
  const reads: string[] = []; // bodies read into memory
  const destroyed: string[] = []; // bodies dropped unread
  const client = {
    async send(command: unknown) {
      sent.push(command);
      if (command instanceof PutObjectCommand) {
        objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const kept = objects.get(command.input.Key!);
        if (!kept) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        const key = command.input.Key!;
        const bytes = Buffer.from(kept);
        if (options.damage) bytes[bytes.length - 1]! ^= 0xff;
        return {
          ContentLength: bytes.length,
          Body: {
            transformToByteArray: async () => {
              reads.push(key);
              return new Uint8Array(bytes);
            },
            destroy: () => destroyed.push(key),
          },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        // two keys a page, so a listing has to follow the continuation token
        const keys = [...objects.keys()].sort();
        const start = Number(command.input.ContinuationToken ?? 0);
        const next = start + 2 < keys.length ? String(start + 2) : undefined;
        return {
          Contents: keys
            .slice(start, start + 2)
            .map((Key) => ({ Key, Size: objects.get(Key)!.length })),
          IsTruncated: next !== undefined,
          NextContinuationToken: next,
        };
      }
      throw new Error("the fake bucket does not know this command");
    },
  };
  return {
    objects,
    sent,
    reads,
    destroyed,
    store: s3Store(client as unknown as S3Client, "files-bucket"),
  };
}
