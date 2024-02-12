import { Schema as S } from "@effect/schema";
import { Context, Effect, pipe } from "effect";
import { process } from "std-env";
import type { File as UndiciFile } from "undici";

import {
  exponentialBackoff,
  fetchEff,
  fetchEffJson,
  generateUploadThingURL,
  UploadThingError,
} from "@uploadthing/shared";
import type {
  ACL,
  ContentDisposition,
  FetchEsque,
  Json,
  MaybeUrl,
} from "@uploadthing/shared";

import { logger } from "../internal/logger";
import { uploadPart } from "../internal/multi-part";

export function guardServerOnly() {
  if (typeof window !== "undefined") {
    throw new UploadThingError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The `utapi` can only be used on the server.",
    });
  }
}

export function getApiKeyOrThrow(apiKey?: string) {
  if (apiKey) return apiKey;
  if (process.env.UPLOADTHING_SECRET) return process.env.UPLOADTHING_SECRET;

  throw new UploadThingError({
    code: "MISSING_ENV",
    message: "Missing `UPLOADTHING_SECRET` env variable.",
  });
}

export const fetchContext = Context.Tag<{
  fetch: FetchEsque;
  utRequestHeaders: Record<string, string>;
}>("fetch-context");

export type FileEsque =
  | (Blob & { name: string; customId?: string })
  | UndiciFile;

export function uploadFilesInternal(
  input: Parameters<typeof getPresignedUrls>[0],
) {
  return pipe(
    getPresignedUrls(input),
    Effect.andThen((presigneds) =>
      // TODO: Catch errors for each file and return data like
      // ({ data, error: null } | { data: null, error })[]
      Effect.all(presigneds.map(uploadFile), { concurrency: 10 }),
    ),
  );
}

/**
 * FIXME: downloading everything into memory and then upload
 * isn't the best. We should support streams so we can download
 * just as much as we need at any time.
 */
export function downloadFiles(urls: MaybeUrl[]) {
  return Effect.gen(function* ($) {
    const context = yield* $(fetchContext);

    const downloads = urls.map((url) =>
      pipe(
        fetchEff(context.fetch, url),
        Effect.andThen((r) => r.blob()),
        Effect.andThen((b) => {
          const name = url.toString().split("/").pop();
          return Object.assign(b, { name: name ?? "unknown-filename" });
        }),
      ),
    );

    return yield* $(Effect.all(downloads, { concurrency: 10 }));
  });
}

function getPresignedUrls(input: {
  files: FileEsque[];
  metadata: Json;
  contentDisposition: ContentDisposition;
  acl?: ACL;
}) {
  return Effect.gen(function* ($) {
    const { files, metadata, contentDisposition, acl } = input;
    const context = yield* $(fetchContext);

    const fileData = files.map((file) => ({
      name: file.name ?? "unnamed-blob",
      type: file.type,
      size: file.size,
      ...("customId" in file ? { customId: file.customId } : {}),
    }));
    logger.debug("Getting presigned URLs for files", fileData);

    const responseSchema = S.struct({
      data: S.array(
        S.struct({
          urls: S.array(S.string),
          key: S.string,
          fileUrl: S.string,
          fileType: S.string,
          uploadId: S.string,
          chunkSize: S.number,
          chunkCount: S.number,
        }),
      ),
    });

    const presigneds = yield* $(
      fetchEffJson(
        context.fetch,
        responseSchema,
        generateUploadThingURL("/api/uploadFiles"),
        {
          method: "POST",
          headers: context.utRequestHeaders,
          cache: "no-store",
          body: JSON.stringify({
            files: fileData,
            metadata,
            contentDisposition,
            acl,
          }),
        },
      ),
    );
    logger.debug("Got presigned URLs:", presigneds.data);

    return files.map((file, i) => ({
      file,
      presigned: presigneds.data[i],
      contentDisposition,
    }));
  });
}

function uploadFile(
  input: Effect.Effect.Success<ReturnType<typeof getPresignedUrls>>[number],
) {
  return Effect.gen(function* ($) {
    const { file, presigned, contentDisposition } = input;

    logger.debug(
      "Uploading file",
      file.name,
      "with",
      presigned.urls.length,
      "chunks of size",
      presigned.chunkSize,
      "bytes each",
    );

    const etags = yield* $(
      Effect.all(
        presigned.urls.map((url, index) => {
          const offset = presigned.chunkSize * index;
          const end = Math.min(offset + presigned.chunkSize, file.size);
          const chunk = file.slice(offset, end);

          return pipe(
            uploadPart({
              url,
              chunk: chunk as Blob,
              contentDisposition,
              contentType: file.type,
              fileName: file.name,
              maxRetries: 10,
              key: presigned.key,
            }),
            Effect.andThen((etag) => ({ tag: etag, partNumber: index + 1 })),
          );
        }),
        { concurrency: "inherit" },
      ),
    );

    logger.debug("File", file.name, "uploaded successfully.");
    logger.debug("Comleting multipart upload...");
    yield* $(completeUpload(presigned, etags));
    logger.debug("Multipart upload complete.");

    return {
      key: presigned.key,
      url: presigned.fileUrl,
      name: file.name,
      size: file.size,
    };
  });
}

function completeUpload(
  presigned: { key: string; uploadId: string },
  etags: { tag: string; partNumber: number }[],
) {
  return Effect.gen(function* ($) {
    const context = yield* $(fetchContext);

    yield* $(
      fetchEff(
        context.fetch,
        generateUploadThingURL("/api/completeMultipart"),
        {
          method: "POST",
          body: JSON.stringify({
            fileKey: presigned.key,
            uploadId: presigned.uploadId,
            etags,
          }),
          headers: context.utRequestHeaders,
        },
      ),
    );

    yield* $(
      fetchEffJson(
        context.fetch,
        S.struct({ status: S.string }),
        generateUploadThingURL(`/api/pollUpload/${presigned.key}`),
        { headers: context.utRequestHeaders },
      ),
      Effect.andThen((res) =>
        res.status === "done"
          ? Effect.succeed(undefined)
          : Effect.fail({ _tag: "NotDone" as const }),
      ),
      Effect.retry({
        while: (err) => err._tag === "NotDone",
        schedule: exponentialBackoff,
      }),
    );
  });
}

type TimeShort = "s" | "m" | "h" | "d";
type TimeLong = "second" | "minute" | "hour" | "day";
type SuggestedNumbers = 2 | 3 | 4 | 5 | 6 | 7 | 10 | 15 | 30 | 60;
// eslint-disable-next-line @typescript-eslint/ban-types
type AutoCompleteableNumber = SuggestedNumbers | (number & {});
export type Time =
  | number
  | `1${TimeShort}`
  | `${AutoCompleteableNumber}${TimeShort}`
  | `1 ${TimeLong}`
  | `${AutoCompleteableNumber} ${TimeLong}s`;

export function parseTimeToSeconds(time: Time) {
  const match = time.toString().split(/(\d+)/).filter(Boolean);
  const num = Number(match[0]);
  const unit = (match[1] ?? "s").trim().slice(0, 1) as TimeShort;

  const multiplier = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  }[unit];

  return num * multiplier;
}
