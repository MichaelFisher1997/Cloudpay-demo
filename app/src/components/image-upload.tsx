import { useRef, useState } from "react";

export function selectUpload(files: File[]): File {
  if (files.length !== 1) throw new Error("Drop one image at a time.");
  const file = files[0]!;
  if (
    file.size === 0 ||
    file.size > 10 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "image/webp"].includes(file.type)
  )
    throw new Error("Choose a JPEG, PNG or WebP up to 10 MiB.");
  return file;
}

export function ImageUpload({
  busy,
  onUpload,
  onError,
}: {
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const uploading = useRef(false);

  async function accept(files: File[]) {
    if (busy || uploading.current) return;
    uploading.current = true;
    try {
      await onUpload(selectUpload(files));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      uploading.current = false;
    }
  }

  return (
    <label
      className={`drop-zone${dragging && !busy ? " is-dragging" : ""}`}
      aria-busy={busy}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? "none" : "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void accept(Array.from(event.dataTransfer.files));
      }}
    >
      <strong>
        {busy
          ? "Uploading image…"
          : dragging
            ? "Drop your image here"
            : "Drag an image here, or click to browse"}
      </strong>
      <span>One JPEG, PNG or WebP at a time, up to 10 MiB.</span>
      <input
        type="file"
        aria-label="Upload an image"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void accept(files);
        }}
      />
    </label>
  );
}
