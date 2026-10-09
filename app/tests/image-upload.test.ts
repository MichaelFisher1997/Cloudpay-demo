import { expect, test } from "bun:test";
import { selectUpload } from "../src/components/image-upload";

test("file picker and drops accept supported images", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const file = new File(["fixture"], "photo", { type });
    expect(selectUpload([file])).toBe(file);
  }
});

test("drops reject empty selections and multiple files", () => {
  const file = new File(["fixture"], "photo.png", { type: "image/png" });
  expect(() => selectUpload([])).toThrow("one image at a time");
  expect(() => selectUpload([file, file])).toThrow("one image at a time");
});

test("drops reject unsupported types and empty images", () => {
  expect(() =>
    selectUpload([
      new File(["fixture"], "photo.svg", { type: "image/svg+xml" }),
    ]),
  ).toThrow("JPEG, PNG or WebP");
  expect(() =>
    selectUpload([new File([], "photo.png", { type: "image/png" })]),
  ).toThrow("JPEG, PNG or WebP");
});

test("drops enforce the 10 MiB limit", () => {
  const limit = 10 * 1024 * 1024;
  const file = new File([new Uint8Array(limit)], "photo.png", {
    type: "image/png",
  });
  expect(selectUpload([file])).toBe(file);
  expect(() =>
    selectUpload([
      new File([new Uint8Array(limit + 1)], "photo.png", { type: "image/png" }),
    ]),
  ).toThrow("10 MiB");
});
