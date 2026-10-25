"use client";

import { useRef, useState } from "react";
import { IconUpload, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

export function Dropzone({ multiple = false }: { multiple?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);

  function take(list: FileList | null) {
    if (!list) return;
    const next = Array.from(list);
    setFiles((current) => {
      if (!multiple) return next.slice(0, 1);
      const existing = new Set(current.map((file) => `${file.name}-${file.lastModified}-${file.size}`));
      return [...current, ...next.filter((file) => !existing.has(`${file.name}-${file.lastModified}-${file.size}`))];
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={() => setOver(true)}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          take(event.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center",
          over ? "border-primary bg-primary-label" : "border-border bg-surface-2",
        )}
      >
        <IconUpload className="mb-3 size-8 text-primary" />
        <p className="font-medium text-heading">Drop files here or click to upload</p>
        <p className="mt-1 text-[0.8125rem] text-muted">
          This is just a demo dropzone. Selected files are not actually uploaded.
        </p>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        className="hidden"
        onChange={(event) => take(event.target.files)}
      />
      {files.length ? (
        <ul className="mt-4 space-y-2">
          {files.map((file) => (
            <li
              key={`${file.name}-${file.lastModified}`}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[0.9375rem]"
            >
              <span className="truncate text-heading">
                {file.name}{" "}
                <span className="text-muted">({Math.round(file.size / 1024)} kb)</span>
              </span>
              <Button
                size="sm"
                variant="text"
                color="secondary"
                iconOnly
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((item) => item !== file))}
              >
                <IconX className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
