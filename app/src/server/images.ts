import { randomUUID } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { imageSize } from "image-size";
import type { Pool } from "pg";
import { config, uploadInput } from "./config";
import { runtime } from "./db";

const MAX = 10 * 1024 * 1024;
const s3 = new S3Client({ region: process.env.AWS_REGION });

export class InputError extends Error {}
export class ConflictError extends Error {}
export class VerificationError extends Error {}

export interface Storage {
  signedPost(
    bucket: string,
    key: string,
    type: string,
    checksum: string,
  ): Promise<{ url: string; fields: Record<string, string> }>;
  head(
    bucket: string,
    key: string,
  ): Promise<{
    version?: string;
    size?: number;
    type?: string;
    checksum?: string;
    etag?: string;
  }>;
  header(bucket: string, key: string, version: string): Promise<Uint8Array>;
  copy(
    bucket: string,
    source: string,
    sourceVersion: string,
    target: string,
    etag?: string,
  ): Promise<string | undefined>;
  delete(bucket: string, key: string, version: string): Promise<void>;
  signedDownload(
    bucket: string,
    key: string,
    version: string,
    type: string,
  ): Promise<string>;
}

export function createUploadPost(
  client: S3Client,
  bucket: string,
  key: string,
  type: string,
  checksum: string,
) {
  return createPresignedPost(client, {
    Bucket: bucket,
    Key: key,
    Expires: 300,
    Fields: { "Content-Type": type, "x-amz-checksum-sha256": checksum },
    Conditions: [
      ["content-length-range", 1, MAX],
      ["eq", "$Content-Type", type],
      ["eq", "$x-amz-checksum-sha256", checksum],
    ],
  });
}

export const awsStorage: Storage = {
  signedPost: (bucket, key, type, checksum) =>
    createUploadPost(s3, bucket, key, type, checksum),
  async head(bucket, key) {
    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: "ENABLED",
      }),
    );
    return {
      version: result.VersionId,
      size: result.ContentLength,
      type: result.ContentType,
      checksum: result.ChecksumSHA256,
      etag: result.ETag,
    };
  },
  async header(bucket, key, version) {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: version,
        Range: "bytes=0-65535",
      }),
    );
    return response.Body?.transformToByteArray() ?? new Uint8Array();
  },
  async copy(bucket, source, sourceVersion, target, etag) {
    const result = await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: target,
        CopySource: `${bucket}/${source}?versionId=${encodeURIComponent(sourceVersion)}`,
        CopySourceIfMatch: etag,
        MetadataDirective: "COPY",
      }),
    );
    return result.VersionId;
  },
  async delete(bucket, key, version) {
    await s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version }),
    );
  },
  signedDownload: (bucket, key, version, type) =>
    getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: version,
        ResponseContentType: type,
      }),
      { expiresIn: 120 },
    ),
};

export type Image = {
  id: string;
  owner_id: string;
  name: string;
  status: "pending" | "finalizing" | "ready" | "deleted";
  pending_key: string;
  image_key: string | null;
  version_id: string | null;
  checksum: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: Date;
};

export function owned(image: Image | undefined, userId: string): Image | null {
  return image?.owner_id === userId && image.status !== "deleted"
    ? image
    : null;
}
export function completionState(
  image: Image | null,
): "missing" | "ready" | "claim" {
  return !image ? "missing" : image.status === "ready" ? "ready" : "claim";
}
export function deletionVersion(
  image: Image | undefined,
): { key: string; version: string } | null {
  return image?.image_key && image.version_id
    ? { key: image.image_key, version: image.version_id }
    : null;
}

export function imageService(db: Pool, storage: Storage, bucket: string) {
  async function lookup(id: string, userId: string): Promise<Image | null> {
    const result = await db.query<Image>(
      "SELECT * FROM images WHERE id=$1 AND owner_id=$2",
      [id, userId],
    );
    return owned(result.rows[0], userId);
  }

  return {
    async list(userId: string) {
      const result = await db.query<Image>(
        "SELECT * FROM images WHERE owner_id=$1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT 100",
        [userId],
      );
      return result.rows.map(
        ({ id, name, status, created_at, width, height }) => ({
          id,
          name,
          status,
          created_at,
          width,
          height,
        }),
      );
    },
    async initiate(
      userId: string,
      input: {
        name: string;
        contentType: string;
        size: number;
        checksum: string;
      },
    ) {
      if (
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 120 ||
        !uploadInput(input.contentType, input.size, input.checksum)
      )
        throw new InputError("Invalid upload");
      const id = randomUUID();
      const key = `pending/${userId}/${id}`;
      await db.query(
        "INSERT INTO images(id,owner_id,name,status,pending_key,checksum,content_type,bytes) VALUES($1,$2,$3,'pending',$4,$5,$6,$7)",
        [
          id,
          userId,
          input.name.trim(),
          key,
          input.checksum,
          input.contentType,
          input.size,
        ],
      );
      return {
        id,
        ...(await storage.signedPost(
          bucket,
          key,
          input.contentType,
          input.checksum,
        )),
      };
    },
    async complete(id: string, userId: string) {
      const row = await lookup(id, userId);
      const state = completionState(row);
      if (state === "missing") return null;
      if (state === "ready") return { id: row!.id, status: "ready" };
      const token = randomUUID();
      const claim = await db.query<Image>(
        `UPDATE images SET status='finalizing',claim_token=$3,claimed_at=now()
         WHERE id=$1 AND owner_id=$2 AND (status='pending' OR
           (status='finalizing' AND claimed_at < now() - interval '2 minutes')) RETURNING *`,
        [id, userId, token],
      );
      if (!claim.rowCount) throw new ConflictError("Finalization in progress");
      const image = claim.rows[0]!;
      const target = `images/${userId}/${id}`;
      let copiedVersion: string | undefined;
      try {
        const head = await storage.head(bucket, image.pending_key);
        if (
          !head.version ||
          !head.size ||
          head.size !== image.bytes ||
          head.size > MAX ||
          head.type !== image.content_type ||
          head.checksum !== image.checksum
        )
          throw new VerificationError("Upload verification failed");
        const bytes = await storage.header(
          bucket,
          image.pending_key,
          head.version,
        );
        if (!bytes.length || bytes.length > 65536)
          throw new VerificationError("Invalid image header");
        let metadata: ReturnType<typeof imageSize>;
        try {
          metadata = imageSize(bytes);
        } catch {
          throw new VerificationError("Invalid image header");
        }
        const formats: Record<string, string> = {
          jpg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        };
        const animatedWebp =
          metadata.type === "webp" &&
          String.fromCharCode(...bytes.slice(12, 16)) === "VP8X" &&
          !!(bytes[20]! & 0x02);
        if (
          !metadata.type ||
          formats[metadata.type] !== image.content_type ||
          !metadata.width ||
          !metadata.height ||
          metadata.width * metadata.height > 40_000_000 ||
          animatedWebp
        )
          throw new VerificationError("Invalid image format");
        copiedVersion = await storage.copy(
          bucket,
          image.pending_key,
          head.version,
          target,
          head.etag,
        );
        if (!copiedVersion)
          throw new VerificationError("Versioned bucket required");
        const final = await db.query<{ id: string; status: string }>(
          `UPDATE images SET status='ready',image_key=$4,version_id=$5,width=$6,height=$7,
           claim_token=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2 AND
           status='finalizing' AND claim_token=$3 RETURNING id,status`,
          [
            id,
            userId,
            token,
            target,
            copiedVersion,
            metadata.width,
            metadata.height,
          ],
        );
        if (!final.rowCount) {
          await storage.delete(bucket, target, copiedVersion);
          return null;
        }
        return final.rows[0]!;
      } catch (error) {
        if (copiedVersion) await storage.delete(bucket, target, copiedVersion);
        await db.query(
          "UPDATE images SET status='pending',claim_token=NULL WHERE id=$1 AND owner_id=$2 AND status='finalizing' AND claim_token=$3",
          [id, userId, token],
        );
        throw error;
      }
    },
    async download(id: string, userId: string) {
      const image = await lookup(id, userId);
      if (
        !image ||
        image.status !== "ready" ||
        !image.image_key ||
        !image.version_id
      )
        return null;
      return {
        url: await storage.signedDownload(
          bucket,
          image.image_key,
          image.version_id,
          image.content_type,
        ),
      };
    },
    async remove(id: string, userId: string) {
      await db.query(
        "UPDATE images SET status='deleted',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status <> 'deleted'",
        [id, userId],
      );
      const image = (
        await db.query<Image>(
          "SELECT * FROM images WHERE id=$1 AND owner_id=$2",
          [id, userId],
        )
      ).rows[0];
      if (!image) return false;
      const pinned = deletionVersion(image);
      if (pinned) await storage.delete(bucket, pinned.key, pinned.version);
      return true;
    },
  };
}

async function service() {
  return imageService((await runtime()).db, awsStorage, config().bucket);
}
export async function list(userId: string) {
  return (await service()).list(userId);
}
export async function initiate(
  userId: string,
  input: Parameters<ReturnType<typeof imageService>["initiate"]>[1],
) {
  return (await service()).initiate(userId, input);
}
export async function complete(id: string, userId: string) {
  return (await service()).complete(id, userId);
}
export async function download(id: string, userId: string) {
  return (await service()).download(id, userId);
}
export async function remove(id: string, userId: string) {
  return (await service()).remove(id, userId);
}
