"use client";

import { type ReactNode, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as ScrollArea from "@radix-ui/react-scroll-area";

interface VirtualizedScrollListProps<T> {
  items: T[];
  /** Item count at which virtualization activates. */
  threshold: number;
  /** Estimated row height (px). */
  estimateSize: number;
  /** Virtualizer overscan count. */
  overscan: number;
  /** Stable key per item. */
  getKey: (item: T) => string | number;
  /** Render a single item. */
  renderItem: (item: T) => ReactNode;
  /** Gap between virtualized rows (px). */
  gap?: number;
  /** Enable dynamic measurement of row elements. */
  measureElements?: boolean;
  /** Class on ScrollArea.Root. */
  rootClassName?: string;
  /** Padding class on the list wrapper and positioned items. */
  paddingClass?: string;
  /** Gap class between items in the non-virtualized list. */
  spacingClass?: string;
}

/**
 * Scroll list that virtualizes when item count >= threshold.
 * Shared by FileRail and TranscriptTimeline.
 */
export function VirtualizedScrollList<T>(props: VirtualizedScrollListProps<T>) {
  const {
    items,
    threshold,
    estimateSize,
    overscan,
    getKey,
    renderItem,
    gap,
    measureElements = false,
    rootClassName = "min-h-0 flex-1",
    paddingClass = "px-3 py-3",
    spacingClass = "space-y-2",
  } = props;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = items.length >= threshold;

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimateSize,
    overscan,
    ...(gap !== undefined ? { gap } : {}),
    ...(measureElements ? { measureElement: (el: Element) => el.getBoundingClientRect().height } : {}),
  });

  // Derive horizontal padding from paddingClass for positioned items.
  const hPadding = paddingClass.split(/\s+/).find((c) => c.startsWith("px-")) ?? "px-3";

  return (
    <ScrollArea.Root className={rootClassName}>
      <ScrollArea.Viewport ref={viewportRef} className="h-full w-full">
        {shouldVirtualize ? (
          <div
            className={`relative min-w-0 ${paddingClass}`}
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((vItem) => {
              const data = items[vItem.index];
              if (!data) return null;
              return (
                <div
                  key={getKey(data)}
                  ref={measureElements ? rowVirtualizer.measureElement : undefined}
                  data-index={measureElements ? vItem.index : undefined}
                  className={`absolute left-0 top-0 w-full ${hPadding}`}
                  style={{ transform: `translateY(${vItem.start}px)` }}
                >
                  {renderItem(data)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className={`min-w-0 ${spacingClass} ${paddingClass}`}>
            {items.map((item) => renderItem(item))}
          </div>
        )}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-2.5 touch-none select-none border-l border-l-transparent p-0.5"
      >
        <ScrollArea.Thumb className="relative flex-1 rounded-full bg-white/12" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
