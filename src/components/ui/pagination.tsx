import { IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight } from "@tabler/icons-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

function pageWindow(current: number, total: number, size = 5) {
  if (total <= size) return Array.from({ length: total }, (_, i) => i);
  const start = Math.max(0, Math.min(current - Math.floor(size / 2), total - size));
  return Array.from({ length: size }, (_, i) => start + i);
}

export function Pagination({
  pageIndex,
  pageCount,
  onPageChange,
  className,
}: {
  pageIndex: number;
  pageCount: number;
  onPageChange: (index: number) => void;
  className?: string;
}) {
  const pages = pageWindow(pageIndex, Math.max(pageCount, 1));

  return (
    <nav className={cn("flex items-center gap-1", className)} aria-label="Pagination">
      <Button
        variant="label"
        color="secondary"
        size="sm"
        iconOnly
        disabled={pageIndex <= 0}
        onClick={() => onPageChange(0)}
        aria-label="First page"
      >
        <IconChevronsLeft className="size-4" />
      </Button>
      <Button
        variant="label"
        color="secondary"
        size="sm"
        iconOnly
        disabled={pageIndex <= 0}
        onClick={() => onPageChange(pageIndex - 1)}
        aria-label="Previous page"
      >
        <IconChevronLeft className="size-4" />
      </Button>
      {pages.map((page) => (
        <Button
          key={page}
          variant={page === pageIndex ? "solid" : "label"}
          color={page === pageIndex ? "primary" : "secondary"}
          size="sm"
          iconOnly
          onClick={() => onPageChange(page)}
        >
          {page + 1}
        </Button>
      ))}
      <Button
        variant="label"
        color="secondary"
        size="sm"
        iconOnly
        disabled={pageIndex >= pageCount - 1}
        onClick={() => onPageChange(pageIndex + 1)}
        aria-label="Next page"
      >
        <IconChevronRight className="size-4" />
      </Button>
      <Button
        variant="label"
        color="secondary"
        size="sm"
        iconOnly
        disabled={pageIndex >= pageCount - 1}
        onClick={() => onPageChange(pageCount - 1)}
        aria-label="Last page"
      >
        <IconChevronsRight className="size-4" />
      </Button>
    </nav>
  );
}
