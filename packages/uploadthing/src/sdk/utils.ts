/**
 * These are imported to make TypeScript aware of the types.
 * It's having a hard time resolving deeply nested stuff from transitive dependencies.
 * You'll notice if you need to add more imports if you get build errors like:
 * `The type of X cannot be inferred without a reference to <MODULE>`
 */
import "@effect/schema/ParseResult";
import "effect/Cause";

import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import { process } from "std-env";
import type { File as UndiciFile } from "undici";

import {
  exponentialBackoff,
  fetchEff,
  fetchEffJson,
  generateUploadThingURL,
  RetryError,
  UploadThingError,
} from "@uploadthing/shared";
import type {
  ACL,
  ContentDisposition,
  Json,
  MaybeUrl,
} from "@uploadthing/shared";

import { logger } from "../internal/logger";
import { completeMultipartUpload, uploadPart } from "../internal/multi-part";
import { mpuSchema, pspSchema } from "../internal/shared-schemas";
import type { MPUResponse, PSPResponse } from "../internal/shared-schemas";
import { UTFile } from "./ut-file";

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

export type FileEsque =
  | (Blob & { name: string; customId?: string })
  | UndiciFile;

export const uploadFilesInternal = (
  input: Parameters<typeof getPresignedUrls>[0],
) =>
  getPresignedUrls(input).pipe(
    Effect.andThen((presigneds) =>
      // TODO: Catch errors for each file and return data like
      // ({ data, error: null } | { data: null, error })[]
      Effect.forEach(
        presigneds,
        (file) =>
          uploadFile(file).pipe(
            Effect.match({
              onFailure: (error) => ({ data: null, error }),
              onSuccess: (data) => ({ data, error: null }),
            }),
          ),
        { concurrency: 10 },
      ),
    ),
  );

/**
 * FIXME: downloading everything into memory and then upload
 * isn't the best. We should support streams so we can download
 * just as much as we need at any time.
 */
export const downloadFiles = (urls: MaybeUrl[]) =>
  Effect.forEach(
    urls,
    (url) =>
      fetchEff(url).pipe(
        Effect.andThen((response) => response.blob()),
        Effect.andThen((blob) => {
          const name = url.toString().split("/").pop();
          return new UTFile([blob], name ?? "unknown-filename");
        }),
      ),
    { concurrency: 10 },
  );

const getPresignedUrls = (input: {
  files: FileEsque[];
  metadata: Json;
  contentDisposition: ContentDisposition;
  acl?: ACL;
}) =>
  Effect.gen(function* ($) {
    const { files, metadata, contentDisposition, acl } = input;

    const fileData = files.map((file) => ({
      name: file.name ?? "unnamed-blob",
      type: file.type,
      size: file.size,
      ...("customId" in file ? { customId: file.customId } : {}),
    }));
    logger.debug("Getting presigned URLs for files", fileData);

    const responseSchema = S.struct({
      data: S.array(S.union(mpuSchema, pspSchema)),
    });

    const presigneds = yield* $(
      fetchEffJson(generateUploadThingURL("/api/uploadFiles"), responseSchema, {
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({
          files: fileData,
          metadata,
          contentDisposition,
          acl,
        }),
      }),
    );
    logger.debug("Got presigned URLs:", presigneds.data);

    return files.map((file, i) => ({
      file,
      presigned: presigneds.data[i],
    }));
  });

const uploadFile = (
  input: Effect.Effect.Success<ReturnType<typeof getPresignedUrls>>[number],
) =>
  Effect.gen(function* ($) {
    const { file, presigned } = input;

    if ("urls" in presigned) {
      yield* $(uploadMultipart(file, presigned));
    } else {
      yield* $(uploadPresignedPost(file, presigned));
    }

    yield* $(
      fetchEffJson(
        generateUploadThingURL(`/api/pollUpload/${presigned.key}`),
        S.struct({ status: S.string }),
      ),
      Effect.andThen((res) =>
        res.status === "done"
          ? Effect.succeed(undefined)
          : Effect.fail(new RetryError()),
      ),
      Effect.retry({
        while: (err) => err instanceof RetryError,
        schedule: exponentialBackoff,
      }),
      Effect.catchTag("RetryError", (e) => Effect.die(e)),
    );

    return {
      key: presigned.key,
      url: presigned.fileUrl,
      name: file.name,
      size: file.size,
    };
  });

const uploadMultipart = (file: FileEsque, presigned: MPUResponse) =>
  Effect.gen(function* ($) {
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

          return uploadPart({
            url,
            chunk: chunk as Blob,
            contentDisposition: presigned.contentDisposition,
            contentType: file.type,
            fileName: file.name,
            maxRetries: 10,
            key: presigned.key,
          }).pipe(
            Effect.andThen((etag) => ({ tag: etag, partNumber: index + 1 })),
            Effect.catchTag("RetryError", (e) => Effect.die(e)),
          );
        }),
        { concurrency: "inherit" },
      ),
    );

    logger.debug("File", file.name, "uploaded successfully.");
    logger.debug("Comleting multipart upload...");
    yield* $(completeMultipartUpload(presigned, etags));
    logger.debug("Multipart upload complete.");
  });

const uploadPresignedPost = (file: FileEsque, presigned: PSPResponse) =>
  Effect.gen(function* ($) {
    logger.debug("Uploading file", file.name, "using presigned POST URL");
    const formData = new FormData();
    Object.entries(presigned.fields).forEach(([k, v]) => formData.append(k, v));
    formData.append("file", file as Blob); // File data **MUST GO LAST**

    const res = yield* $(
      fetchEff(presigned.url, {
        method: "POST",
        body: formData,
        headers: new Headers({
          Accept: "application/xml",
        }),
      }),
    );

    if (!res.ok) {
      const text = yield* $(Effect.promise(res.text));
      logger.error("Failed to upload file:", text);
      throw new UploadThingError({
        code: "UPLOAD_FAILED",
        message: "Failed to upload file",
        cause: text,
      });
    }

    logger.debug("File", file.name, "uploaded successfully");
  });

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
