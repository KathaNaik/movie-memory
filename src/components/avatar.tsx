"use client";

import Image from "next/image";
import { useState } from "react";

/** Profile photo, falling back to the name's initial if missing or broken. */
export function Avatar({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <Image
        src={src}
        alt=""
        width={40}
        height={40}
        onError={() => setFailed(true)}
        className="size-10 shrink-0 rounded-full ring-2 ring-white"
      />
    );
  }

  return (
    <div
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white font-semibold text-accent"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
