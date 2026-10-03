import type { RefObject } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

export default function PinScreenEntrance({
  target,
}: {
  target: RefObject<HTMLElement | null>;
}) {
  useGSAP(
    () => {
      const root = target.current;
      if (
        !root ||
        !window.matchMedia ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;

      const content = Array.from(
        root.querySelectorAll<HTMLElement>("[data-pin-reveal]"),
      );
      const entrance = gsap.timeline();
      if (content.length) {
        entrance.from(
          content,
          {
            autoAlpha: 0,
            y: 6,
            duration: 0.18,
            stagger: 0.03,
            ease: "power3.out",
            clearProps: "transform,opacity,visibility",
          },
          0,
        );
      }
      return () => entrance.kill();
    },
    { scope: target, revertOnUpdate: true },
  );

  return null;
}
