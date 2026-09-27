"use client";

import { useLayoutEffect, useRef } from "react";
import {
  HEADER_HEIGHT_DESKTOP_PX,
  HEADER_HEIGHT_MOBILE_PX,
} from "@/lib/layoutConstants";

const DESKTOP_MQ = "(min-width: 768px)";
const ROTATION_WIDTH_DELTA = 64;

function headerOffsetPx() {
  return window.matchMedia(DESKTOP_MQ).matches
    ? HEADER_HEIGHT_DESKTOP_PX
    : HEADER_HEIGHT_MOBILE_PX;
}

function viewportBox() {
  const visual = window.visualViewport;
  const width = Math.round(visual?.width ?? window.innerWidth);
  const height = Math.round(
    Math.max(
      window.innerHeight,
      visual?.height ?? 0,
      document.documentElement.clientHeight
    )
  );
  return { width, height };
}

export default function ChatPortraitBackground({ imageUrl }: { imageUrl: string }) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const lockedRef = useRef<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const apply = (relock: boolean) => {
      const header = headerOffsetPx();
      const next = viewportBox();
      const prev = lockedRef.current;
      const rotated =
        !prev || Math.abs(next.width - prev.width) >= ROTATION_WIDTH_DELTA;

      if (relock || rotated) {
        lockedRef.current = {
          width: next.width,
          height: Math.max(0, next.height - header),
        };
      }

      const locked = lockedRef.current;
      if (!locked) return;

      node.style.position = "fixed";
      node.style.left = "0px";
      node.style.right = "auto";
      node.style.top = `${header}px`;
      node.style.width = `${locked.width}px`;
      node.style.height = `${locked.height}px`;
      node.style.minHeight = `${locked.height}px`;
      node.style.maxHeight = `${locked.height}px`;
    };

    apply(true);

    const onResize = () => apply(false);
    const onRotate = () => apply(true);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onRotate);
    const mq = window.matchMedia(DESKTOP_MQ);
    mq.addEventListener("change", onRotate);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onRotate);
      mq.removeEventListener("change", onRotate);
    };
  }, []);

  return (
    <div
      ref={nodeRef}
      className="nv-chat-portrait"
      style={{ backgroundImage: `url(${imageUrl})` }}
      aria-hidden
    />
  );
}
