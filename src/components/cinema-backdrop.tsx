import Image from "next/image";
import type { ReactNode } from "react";

import cinemaBackground from "./cinema-background.png";

/**
 * Fills the available space with the cinema artwork and places `children`
 * inside its white panel.
 *
 * From lg up, the artwork is scaled like `background-size: cover` (filling
 * width and height, centered). Because the white panel is centered in the
 * artwork, it stays centered on screen, and percentage insets measured from
 * the image keep the content inside it. Only the decorated edges get cropped.
 * Below lg the panel would be too small, so content sits on a plain white card.
 */
export function CinemaBackdrop({ children }: { children: ReactNode }) {
  return (
    // Size containment (lg only) lets the artwork size itself from this
    // element's height via cqh units.
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#f4edf9] px-4 py-10 text-zinc-900 lg:p-0 lg:[container-type:size]">
      <div className="relative w-full max-w-md lg:absolute lg:top-1/2 lg:left-1/2 lg:aspect-[2118/1189] lg:w-[max(100cqw,calc(100cqh*2118/1189))] lg:max-w-none lg:-translate-x-1/2 lg:-translate-y-1/2">
        <Image
          src={cinemaBackground}
          alt=""
          fill
          priority
          sizes="(min-width: 1024px) 100vw, 1px"
          className="hidden lg:block"
        />
        {/* lg inset = the part of the white panel no illustration overlaps
            (measured from the image). Scrolls if content outgrows it. */}
        <div className="relative flex flex-col gap-5 rounded-2xl bg-white p-6 shadow-sm lg:absolute lg:inset-[30%_30%_24%_30%] lg:justify-center-safe lg:overflow-y-auto lg:rounded-none lg:bg-transparent lg:p-1 lg:shadow-none">
          {children}
        </div>
      </div>
    </main>
  );
}
