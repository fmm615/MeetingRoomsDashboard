import type { Transition, Variants } from "framer-motion";

export const MOTION_EASE: [number, number, number, number] = [
  0.22,
  1,
  0.36,
  1,
];

export const MOTION_DURATIONS = {
  hover: 0.15,
  control: 0.16,
  card: 0.22,
  step: 0.22,
  page: 0.28,
  backdrop: 0.24,
  drawer: 0.26,
  feedback: 0.16,
  confirmation: 0.28,
  reduced: 0.08,
} as const;

export const motionTransition: Transition = {
  type: "tween",
  duration: MOTION_DURATIONS.card,
  ease: MOTION_EASE,
};

export const reducedMotionTransition: Transition = {
  type: "tween",
  duration: MOTION_DURATIONS.reduced,
  ease: MOTION_EASE,
  delay: 0,
};

export interface MotionVariantCollection {
  page: Variants;
  roomGrid: Variants;
  roomCard: Variants;
  step: Variants;
  backdrop: Variants;
  desktopDrawer: Variants;
  mobileSheet: Variants;
  drawer: Variants;
  error: Variants;
  toast: Variants;
  buttonLabel: Variants;
  confirmation: Variants;
  confirmationIcon: Variants;
  confirmationItem: Variants;
}

/**
 * Creates the shared variants used by the booking UI.
 *
 * Step variants accept a custom direction where `1` means forward and `-1`
 * means backward. The `drawer` alias selects the desktop or mobile treatment
 * without requiring consuming components to duplicate viewport logic.
 */
export function makeMotionVariants(
  reduceMotion: boolean,
  mobile: boolean,
): MotionVariantCollection {
  const transition = (duration: number, delay = 0): Transition => ({
    type: "tween",
    duration: reduceMotion
      ? Math.min(duration, MOTION_DURATIONS.reduced)
      : duration,
    ease: MOTION_EASE,
    delay: reduceMotion ? 0 : delay,
  });

  const page: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 8,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: transition(MOTION_DURATIONS.page),
    },
    exit: {
      opacity: 0,
      y: reduceMotion ? 0 : -6,
      transition: transition(MOTION_DURATIONS.card),
    },
  };

  const roomGrid: Variants = {
    hidden: {},
    visible: {
      transition: {
        ...transition(MOTION_DURATIONS.card),
        delayChildren: 0,
        staggerChildren: reduceMotion ? 0 : 0.05,
      },
    },
  };

  const roomCard: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 8,
    },
    visible: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: transition(MOTION_DURATIONS.card),
    },
    hover: {
      y: reduceMotion ? 0 : -2,
      scale: 1,
      transition: transition(MOTION_DURATIONS.hover),
    },
    selected: {
      y: 0,
      scale: reduceMotion ? 1 : 1.005,
      transition: transition(MOTION_DURATIONS.card),
    },
    tap: {
      scale: reduceMotion ? 1 : 0.99,
      transition: transition(MOTION_DURATIONS.control),
    },
  };

  const step: Variants = {
    enter: (direction: number = 1) => ({
      opacity: 0,
      x: reduceMotion ? 0 : Math.sign(direction || 1) * 14,
    }),
    center: {
      opacity: 1,
      x: 0,
      transition: transition(MOTION_DURATIONS.step),
    },
    visible: {
      opacity: 1,
      x: 0,
      transition: transition(MOTION_DURATIONS.step),
    },
    exit: (direction: number = 1) => ({
      opacity: 0,
      x: reduceMotion ? 0 : Math.sign(direction || 1) * -12,
      transition: transition(MOTION_DURATIONS.step),
    }),
  };

  const backdrop: Variants = {
    hidden: { opacity: 0, visibility: "hidden" },
    visible: {
      opacity: 1,
      visibility: "visible",
      transition: transition(MOTION_DURATIONS.backdrop),
    },
    exit: {
      opacity: 0,
      transition: transition(MOTION_DURATIONS.backdrop),
      transitionEnd: { visibility: "hidden" },
    },
  };

  const desktopDrawer: Variants = {
    hidden: {
      opacity: 0,
      x: reduceMotion ? 0 : 32,
      visibility: "hidden",
    },
    visible: {
      opacity: 1,
      x: 0,
      visibility: "visible",
      transition: transition(MOTION_DURATIONS.drawer),
    },
    exit: {
      opacity: 0,
      x: reduceMotion ? 0 : 32,
      transition: transition(MOTION_DURATIONS.drawer),
      transitionEnd: { visibility: "hidden" },
    },
  };

  const mobileSheet: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 40,
      visibility: "hidden",
    },
    visible: {
      opacity: 1,
      y: 0,
      visibility: "visible",
      transition: transition(MOTION_DURATIONS.drawer),
    },
    exit: {
      opacity: 0,
      y: reduceMotion ? 0 : 40,
      transition: transition(MOTION_DURATIONS.drawer),
      transitionEnd: { visibility: "hidden" },
    },
  };

  const error: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : -4,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: transition(MOTION_DURATIONS.feedback),
    },
    exit: {
      opacity: 0,
      y: reduceMotion ? 0 : -4,
      transition: transition(MOTION_DURATIONS.feedback),
    },
  };

  const toast: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 6,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: transition(MOTION_DURATIONS.feedback),
    },
    exit: {
      opacity: 0,
      y: reduceMotion ? 0 : 4,
      transition: transition(MOTION_DURATIONS.feedback),
    },
  };

  const buttonLabel: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: transition(MOTION_DURATIONS.control),
    },
    exit: {
      opacity: 0,
      transition: transition(MOTION_DURATIONS.control),
    },
  };

  const confirmation: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 8,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        ...transition(MOTION_DURATIONS.confirmation),
        delayChildren: 0,
        staggerChildren: reduceMotion ? 0 : 0.05,
      },
    },
    exit: {
      opacity: 0,
      y: reduceMotion ? 0 : -4,
      transition: transition(MOTION_DURATIONS.card),
    },
  };

  const confirmationIcon: Variants = {
    hidden: {
      opacity: 0,
      scale: reduceMotion ? 1 : 0.9,
    },
    visible: {
      opacity: 1,
      scale: 1,
      transition: transition(MOTION_DURATIONS.card),
    },
  };

  const confirmationItem: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 4,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: transition(MOTION_DURATIONS.card),
    },
  };

  return {
    page,
    roomGrid,
    roomCard,
    step,
    backdrop,
    desktopDrawer,
    mobileSheet,
    drawer: mobile ? mobileSheet : desktopDrawer,
    error,
    toast,
    buttonLabel,
    confirmation,
    confirmationIcon,
    confirmationItem,
  };
}
