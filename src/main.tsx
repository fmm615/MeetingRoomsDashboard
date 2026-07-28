import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import {
  MOTION_DURATIONS,
  MOTION_EASE,
  makeMotionVariants,
  type MotionVariantCollection,
} from "./motion-config";

const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;
const SLOT_MINUTES = 15;
const TOTAL_SLOTS = ((CLOSE_HOUR - OPEN_HOUR) * 60) / SLOT_MINUTES;
const BOOKING_WINDOW_DAYS = 14;
const WEEKEND_CLOSED_MESSAGE =
  "Bookings are unavailable on Fridays and Saturdays.";

interface Room {
  id: string;
  slug: string;
  name: string;
  location: string;
  capacityLabel: string;
  compactDescription: string;
  purpose: string;
  recommendedUses: string[];
  guidelines: string[];
  bookingIncrementMinutes: number;
  minimumDurationMinutes: number;
  maximumDurationMinutes: number;
  allowedDurationsMinutes: number[];
  isActive: boolean;
}

interface BusyInterval {
  room: string;
  start: number;
  end: number;
  type: "booked" | "blocked";
}

type OrganizerGroup = "PLAYBOOK" | "O&H" | "Joint";

interface Booking {
  room: string;
  roomName: string;
  location: string;
  date: string;
  start: number;
  end: number;
  durationMinutes: number;
  bookedBy: string;
  organizerGroup: OrganizerGroup;
  attendees: string;
  email: string;
  meetingTitle: string;
  notes: string;
  reference: string;
  status: "confirmed" | "cancelled";
}

interface Selection {
  date: string;
  room: string;
  start: number | null;
  end: number | null;
}

interface BookingDraft {
  name: string;
  organizerGroup: OrganizerGroup;
  attendees: string;
  email: string;
  title: string;
  notes: string;
}

type PageMode = "booking" | "manage" | "service";
type DialogType = "details" | "guidelines" | null;

interface ApiError extends Error {
  status?: number;
}

interface ToastMessage {
  id: number;
  message: string;
}

interface RealtimeConfig {
  enabled: boolean;
  url?: string;
  publishableKey?: string;
}

function localISO(date: Date): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function formatDate(value: string, full = false): string {
  return parseDate(value).toLocaleDateString(
    "en-GB",
    full
      ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
      : { weekday: "short", day: "numeric", month: "short" },
  );
}

function slotToTime(slot: number): string {
  const minutes = OPEN_HOUR * 60 + slot * SLOT_MINUTES;
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return "1 hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${Math.floor(minutes / 60)} hour ${minutes % 60} minutes`;
}

function organizerGroupLabel(value: OrganizerGroup): string {
  return value === "Joint" ? "PLAYBOOK & O&H" : value;
}

function dateBounds(): { minimum: string; maximum: string } {
  const today = new Date();
  return {
    minimum: localISO(today),
    maximum: localISO(addDays(today, BOOKING_WINDOW_DAYS)),
  };
}

function isDateInBookingWindow(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseDate(value);
  if (Number.isNaN(parsed.getTime()) || localISO(parsed) !== value) return false;
  const { minimum, maximum } = dateBounds();
  return value >= minimum && value <= maximum;
}

function isWeekendDate(value: string): boolean {
  if (!isDateInBookingWindow(value)) return false;
  const day = parseDate(value).getDay();
  return day === 5 || day === 6;
}

function isDateAllowed(value: string): boolean {
  return isDateInBookingWindow(value) && !isWeekendDate(value);
}

function nextBookableDate(value: string): string {
  let date = parseDate(value);
  while (isWeekendDate(localISO(date))) {
    date = addDays(date, 1);
  }
  return localISO(date);
}

function isPastSlot(date: string, slot: number): boolean {
  const time = parseDate(date);
  const minutes = OPEN_HOUR * 60 + slot * SLOT_MINUTES;
  time.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return time <= new Date();
}

function durationOptions(room: Room): number[] {
  if (Array.isArray(room.allowedDurationsMinutes) && room.allowedDurationsMinutes.length) {
    return room.allowedDurationsMinutes;
  }
  const durations: number[] = [];
  for (
    let duration = room.minimumDurationMinutes || room.bookingIncrementMinutes;
    duration <= room.maximumDurationMinutes;
    duration += room.bookingIncrementMinutes
  ) {
    durations.push(duration);
  }
  return durations;
}

function durationBadge(room: Room): string {
  if (room.slug === "standing-workstations") return "15–60 minutes";
  if (room.slug === "quiet-pods") return "30–45 minutes";
  return `Up to ${formatDuration(room.maximumDurationMinutes)}`;
}

function durationPolicy(room: Room): string {
  if (room.slug === "standing-workstations") {
    return "Bookings may be 15, 30, 45, or 60 minutes.";
  }
  if (room.slug === "quiet-pods") return "Bookings may be 30 or 45 minutes.";
  return `Maximum booking time is ${formatDuration(room.maximumDurationMinutes)}.`;
}

function durationError(room: Room): string {
  if (room.slug === "meeting-room") {
    return "The Meeting Room can be booked for a maximum of 2 hours.";
  }
  if (room.slug === "standing-workstations") {
    return "Standing Workstations can only be booked for 15–60 minutes.";
  }
  if (room.slug === "innovation-hub") {
    return "The Innovation Hub can be booked for a maximum of 2 hours.";
  }
  if (room.slug === "quiet-pods") {
    return "Quiet Pods can only be booked for 30 or 45 minutes.";
  }
  return `${room.name} cannot be booked for the selected duration.`;
}

function conflictFor(
  busy: BusyInterval[],
  roomId: string,
  start: number,
  end: number,
): BusyInterval | undefined {
  return busy.find(
    (interval) =>
      interval.room === roomId && start < interval.end && end > interval.start,
  );
}

function durationIsAvailable(
  room: Room,
  date: string,
  busy: BusyInterval[],
  start: number,
  durationMinutes: number,
): boolean {
  const slots = durationMinutes / SLOT_MINUTES;
  const end = start + slots;
  return (
    Number.isInteger(slots) &&
    durationOptions(room).includes(durationMinutes) &&
    end <= TOTAL_SLOTS &&
    !isPastSlot(date, start) &&
    !conflictFor(busy, room.id, start, end)
  );
}

function roomHasAvailability(
  room: Room,
  date: string,
  busy: BusyInterval[],
  loading: boolean,
): boolean | null {
  if (loading) return null;
  for (let slot = 0; slot < TOTAL_SLOTS; slot += 1) {
    if (
      durationOptions(room).some((duration) =>
        durationIsAvailable(room, date, busy, slot, duration),
      )
    ) {
      return true;
    }
  }
  return false;
}

function selectionError(
  selection: Selection,
  rooms: Room[],
  busy: BusyInterval[],
): string {
  if (isWeekendDate(selection.date)) return WEEKEND_CLOSED_MESSAGE;
  if (!isDateAllowed(selection.date)) {
    return `Choose a date within the next ${BOOKING_WINDOW_DAYS} days.`;
  }
  const room = rooms.find((candidate) => candidate.id === selection.room);
  if (!room?.isActive) return "Select an active room or workspace.";
  if (
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end) ||
    (selection.start ?? -1) < 0 ||
    (selection.end ?? 0) <= (selection.start ?? -1) ||
    (selection.end ?? TOTAL_SLOTS + 1) > TOTAL_SLOTS
  ) {
    return "Select a valid start time and duration within office hours.";
  }
  const start = selection.start as number;
  const end = selection.end as number;
  const duration = (end - start) * SLOT_MINUTES;
  if (!durationOptions(room).includes(duration)) return durationError(room);
  if (isPastSlot(selection.date, start)) {
    return "The selected start time is in the past. Choose another time.";
  }
  if (conflictFor(busy, room.id, start, end)) {
    return "This room is booked or unavailable during the selected time. Select another time or room.";
  }
  return "";
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // A stable fallback error is supplied below.
  }
  if (!response.ok) {
    const error = new Error(
      String(payload.error || "The booking service could not complete this request."),
    ) as ApiError;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

function visibleDates(centerValue: string): Date[] {
  const { minimum, maximum } = dateBounds();
  const minimumDate = parseDate(minimum);
  const maximumDate = parseDate(maximum);
  let start = parseDate(centerValue);
  if (start < minimumDate) start = minimumDate;
  if (start > maximumDate) start = maximumDate;
  const latestFiveDayStart = addDays(maximumDate, -4);
  if (start > latestFiveDayStart) start = latestFiveDayStart;
  const dates: Date[] = [];
  let cursor = start;
  while (dates.length < 5 && cursor <= maximumDate) {
    dates.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function buttonMotion(reduced: boolean, enabled = true) {
  if (reduced || !enabled) return {};
  return {
    whileHover: { y: -1 },
    whileTap: { scale: 0.98 },
    transition: {
      type: "tween" as const,
      duration: MOTION_DURATIONS.control,
      ease: MOTION_EASE,
    },
  };
}

function useIsMobile(): boolean {
  const query = "(max-width: 760px)";
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

function Header({ onHome }: { onHome: () => void }) {
  return (
    <header className="topbar">
      <a
        className="brand"
        href="/book"
        aria-label="Playbook Office Rooms"
        onClick={(event) => {
          event.preventDefault();
          onHome();
        }}
      >
        <img src="/logoPurpleFontWhiteBG.png" alt="Playbook" />
        <span />
        <strong>Office Rooms</strong>
      </a>
      <div className="topbar-date" id="current-date">
        {new Date().toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        })}
      </div>
    </header>
  );
}

function ProgressSteps({ selection }: { selection: Selection }) {
  const currentStep = !selection.date ? 1 : !selection.room ? 2 : 3;
  return (
    <ol className="steps" aria-label="Booking progress">
      {[1, 2, 3].map((stepNumber, index) => (
        <React.Fragment key={stepNumber}>
          {index > 0 && <li className="step-divider" aria-hidden="true" />}
          <li
            className={`step ${stepNumber <= currentStep ? "active" : ""}`}
            data-step={stepNumber}
            aria-current={stepNumber === currentStep ? "step" : undefined}
          >
            <span>{stepNumber}</span>
            <div>
              <small>Step {stepNumber}</small>
              <strong>{["Date", "Room", "Time"][index]}</strong>
            </div>
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

interface DateSelectorProps {
  selection: Selection;
  windowAnchor: string;
  reduced: boolean;
  onChoose: (value: string) => void;
  onWindowAnchor: (value: string) => void;
}

function openNativeDatePicker(input: HTMLInputElement) {
  if (typeof input.showPicker !== "function") return;
  try {
    input.showPicker();
  } catch {
    // The input's native click remains the fallback in browsers that
    // restrict showPicker() despite a user gesture.
  }
}

function DateSelector({
  selection,
  windowAnchor,
  reduced,
  onChoose,
  onWindowAnchor,
}: DateSelectorProps) {
  const dates = visibleDates(windowAnchor);
  const { minimum, maximum } = dateBounds();
  return (
    <section className="panel date-panel">
      <div className="section-heading">
        <div>
          <span className="section-number">1</span>
          <div>
            <h2>Select a date</h2>
            <p>
              Book up to 14 days ahead. Fridays and Saturdays are unavailable.
            </p>
          </div>
        </div>
        <label className="date-picker">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z" />
          </svg>
          Other date
          <input
            id="date-input"
            type="date"
            aria-label="Choose another booking date"
            min={minimum}
            max={maximum}
            value={selection.date}
            onClick={(event) => openNativeDatePicker(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              if (typeof event.currentTarget.showPicker !== "function") return;
              event.preventDefault();
              openNativeDatePicker(event.currentTarget);
            }}
            onChange={(event) => {
              if (!event.target.value) return;
              if (isDateAllowed(event.target.value)) {
                onWindowAnchor(event.target.value);
              }
              onChoose(event.target.value);
            }}
          />
        </label>
      </div>
      <div className="date-strip" id="date-strip">
        {dates.map((date) => {
          const value = localISO(date);
          const selected = value === selection.date;
          const weekend = isWeekendDate(value);
          return (
            <motion.button
              type="button"
              className={`date-card ${selected ? "selected" : ""} ${
                weekend ? "weekend" : ""
              }`}
              data-date={value}
              aria-pressed={selected}
              aria-label={
                weekend
                  ? `${formatDate(value, true)}, weekend unavailable`
                  : formatDate(value, true)
              }
              disabled={weekend}
              key={value}
              onClick={() => onChoose(value)}
              {...buttonMotion(reduced, !weekend)}
            >
              {selected && (
                <motion.span
                  className="selected-date-indicator"
                  data-motion-id="selected-date"
                  layoutId="selected-date"
                  transition={{
                    type: "tween",
                    duration: reduced ? MOTION_DURATIONS.reduced : 0.2,
                    ease: MOTION_EASE,
                  }}
                />
              )}
              <span className="date-card-content">
                {date.toLocaleDateString("en-GB", { weekday: "short" })}
                <strong>{date.getDate()}</strong>
                {date.toLocaleDateString("en-GB", { month: "short" })}
                {weekend && (
                  <small className="date-card-status">Unavailable</small>
                )}
              </span>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}

function RoomSkeletons({ reduced }: { reduced: boolean }) {
  return (
    <div className={`room-grid skeleton-grid ${reduced ? "reduced" : ""}`} aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="room-skeleton" key={index}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

interface RoomGridProps {
  rooms: Room[];
  selection: Selection;
  busy: BusyInterval[];
  loading: boolean;
  roomsLoading: boolean;
  reduced: boolean;
  variants: MotionVariantCollection;
  onChoose: (roomId: string) => void;
  onGuidelines: (roomId: string, opener: HTMLElement) => void;
}

function RoomGrid({
  rooms,
  selection,
  busy,
  loading,
  roomsLoading,
  reduced,
  variants,
  onChoose,
  onGuidelines,
}: RoomGridProps) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <span className="section-number">2</span>
          <div>
            <h2>Select a room or workspace</h2>
            <p>Choose the space that fits your booking.</p>
          </div>
        </div>
      </div>
      {roomsLoading ? (
        <RoomSkeletons reduced={reduced} />
      ) : (
        <motion.div
          className="room-grid"
          id="room-grid"
          variants={variants.roomGrid}
          initial="hidden"
          animate="visible"
        >
          {rooms.map((room) => {
            const selected = selection.room === room.id;
            const availability = roomHasAvailability(
              room,
              selection.date,
              busy,
              loading,
            );
            const availabilityText =
              availability === null
                ? "Checking availability"
                : availability
                  ? "Available on selected date"
                  : "No available times";
            const canSelect = availability === true;
            return (
              <motion.article
                className={`room-card ${selected ? "selected" : ""} ${
                  availability === false ? "unavailable" : ""
                }`}
                data-room-card={room.id}
                key={room.id}
                variants={variants.roomCard}
                whileHover={canSelect ? "hover" : undefined}
              >
                <div className="room-title-row">
                  <h3>{room.name}</h3>
                  <AnimatePresence initial={false}>
                    {selected && (
                      <motion.span
                        className="room-selected-indicator"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{
                          duration: reduced ? MOTION_DURATIONS.reduced : 0.16,
                          ease: MOTION_EASE,
                        }}
                      >
                        Selected
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
                {room.location && <p className="room-location">{room.location}</p>}
                <p>{room.compactDescription}</p>
                <div className="room-badges">
                  {room.capacityLabel && (
                    <span className="room-badge">{room.capacityLabel}</span>
                  )}
                  <span className="room-badge">{durationBadge(room)}</span>
                </div>
                <p
                  className={`room-availability ${
                    availability === false ? "unavailable" : ""
                  }`}
                  aria-live="polite"
                >
                  <span className="status-dot" aria-hidden="true" />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      className="availability-label"
                      key={availabilityText}
                      variants={variants.buttonLabel}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      {availabilityText}
                    </motion.span>
                  </AnimatePresence>
                </p>
                <div className="room-actions">
                  <motion.button
                    type="button"
                    className="guidelines-button"
                    data-guidelines={room.id}
                    onClick={(event) =>
                      onGuidelines(room.id, event.currentTarget)
                    }
                    {...buttonMotion(reduced)}
                  >
                    View guidelines
                  </motion.button>
                  <motion.button
                    type="button"
                    className="select-room-button"
                    data-room={room.id}
                    aria-pressed={selected}
                    disabled={!canSelect}
                    onClick={() => onChoose(room.id)}
                    {...buttonMotion(reduced, canSelect)}
                  >
                    {selected
                      ? "Selected"
                      : availability === false
                        ? "Unavailable"
                        : availability === null
                          ? "Checking"
                          : "Select"}
                  </motion.button>
                </div>
              </motion.article>
            );
          })}
        </motion.div>
      )}
    </section>
  );
}

interface TimePanelProps {
  rooms: Room[];
  selection: Selection;
  busy: BusyInterval[];
  loading: boolean;
  availabilityError: string;
  reduced: boolean;
  variants: MotionVariantCollection;
  onChooseStart: (slot: number) => void;
  onChooseDuration: (duration: number) => void;
}

function TimePanel({
  rooms,
  selection,
  busy,
  loading,
  availabilityError,
  reduced,
  variants,
  onChooseStart,
  onChooseDuration,
}: TimePanelProps) {
  const room = rooms.find((candidate) => candidate.id === selection.room);
  const selectedDuration =
    selection.start !== null && selection.end !== null
      ? (selection.end - selection.start) * SLOT_MINUTES
      : null;

  return (
    <section className="panel time-panel">
      <div className="section-heading">
        <div>
          <span className="section-number">3</span>
          <div>
            <h2>Select a time</h2>
            <p id="time-help">
              {room
                ? `15-minute start times · ${durationBadge(room)}`
                : "Select a room to see availability."}
            </p>
          </div>
        </div>
        <div className="legend">
          <span>
            <i className="available" />
            Available
          </span>
          <span>
            <i className="booked" />
            Booked
          </span>
          <span>
            <i className="unavailable" />
            Unavailable
          </span>
        </div>
      </div>
      <AnimatePresence mode="sync" initial={false}>
        {!room ? (
          <motion.div
            id="time-empty"
            className="empty-state"
            key="empty"
            variants={variants.step}
            initial="enter"
            animate="center"
            exit="exit"
          >
            Choose a room above to view its available times.
          </motion.div>
        ) : (
          <motion.div
            id="time-content"
            className="time-content"
            key={`time-${room.id}`}
            variants={variants.step}
            custom={1}
            initial="enter"
            animate="center"
            exit="exit"
            aria-busy={loading}
          >
            <AnimatePresence initial={false}>
              {availabilityError && (
                <motion.div
                  className="availability-error"
                  role="alert"
                  variants={variants.error}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {availabilityError}
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {loading && (
                <motion.div
                  className="availability-refresh"
                  role="status"
                  aria-live="polite"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: reduced ? MOTION_DURATIONS.reduced : 0.16,
                    ease: MOTION_EASE,
                  }}
                >
                  Checking availability
                </motion.div>
              )}
            </AnimatePresence>
            <div className="time-duration-layout">
              <fieldset className="time-choice" disabled={loading}>
                <legend>Start time</legend>
                <p>Times use 15-minute intervals.</p>
                <div className="time-grid" id="time-grid">
                  {Array.from({ length: TOTAL_SLOTS }, (_, slot) => {
                    const past = isPastSlot(selection.date, slot);
                    const interval = conflictFor(busy, room.id, slot, slot + 1);
                    const hasDuration = durationOptions(room).some((duration) =>
                      durationIsAvailable(
                        room,
                        selection.date,
                        busy,
                        slot,
                        duration,
                      ),
                    );
                    const unavailable = past || Boolean(interval) || !hasDuration;
                    const selected = selection.start === slot;
                    const type =
                      past || (!interval && !hasDuration)
                        ? "unavailable"
                        : interval?.type === "booked"
                          ? "booked"
                          : "unavailable";
                    const status = selected
                      ? "selected"
                      : type === "booked"
                        ? "booked"
                        : unavailable
                          ? "unavailable"
                          : "available";
                    return (
                      <motion.button
                        type="button"
                        className={`time-slot ${
                          unavailable ? type : ""
                        } ${selected ? "selected" : ""}`}
                        data-slot={slot}
                        aria-label={`${slotToTime(slot)}, ${status}`}
                        aria-pressed={selected}
                        disabled={unavailable || loading}
                        key={slot}
                        onClick={() => onChooseStart(slot)}
                        animate={{
                          scale: selected && !reduced ? 1.02 : 1,
                        }}
                        whileHover={
                          !unavailable && !loading && !reduced
                            ? { y: -1 }
                            : undefined
                        }
                        whileTap={
                          !unavailable && !loading && !reduced
                            ? { scale: 0.98 }
                            : undefined
                        }
                        transition={{
                          type: "tween",
                          duration: MOTION_DURATIONS.control,
                          ease: MOTION_EASE,
                        }}
                      >
                        {slotToTime(slot)}
                      </motion.button>
                    );
                  })}
                </div>
              </fieldset>
              <fieldset className="duration-choice" disabled={loading}>
                <legend>Duration</legend>
                <p id="duration-help">
                  {selection.start === null
                    ? "Select a start time first."
                    : `Starting at ${slotToTime(selection.start)}.`}
                </p>
                <div className="duration-grid" id="duration-grid">
                  {durationOptions(room).map((duration) => {
                    const end =
                      selection.start === null
                        ? null
                        : selection.start + duration / SLOT_MINUTES;
                    const selected =
                      end !== null &&
                      selection.end === end &&
                      selectedDuration === duration;
                    const valid =
                      selection.start !== null &&
                      durationIsAvailable(
                        room,
                        selection.date,
                        busy,
                        selection.start,
                        duration,
                      );
                    const reason =
                      selection.start === null
                        ? "select a start time first"
                        : (end ?? 0) > TOTAL_SLOTS
                          ? "extends beyond office hours"
                          : conflictFor(
                                busy,
                                room.id,
                                selection.start,
                                end ?? selection.start,
                              )
                            ? "overlaps an unavailable period"
                            : "unavailable";
                    return (
                      <motion.button
                        type="button"
                        className={`duration-option ${
                          selected ? "selected" : ""
                        }`}
                        data-duration={duration}
                        aria-pressed={selected}
                        aria-label={`${formatDuration(duration)}${
                          valid ? "" : `, ${reason}`
                        }`}
                        disabled={!valid || loading}
                        key={duration}
                        onClick={() => onChooseDuration(duration)}
                        animate={{
                          scale: selected && !reduced ? 1.01 : 1,
                        }}
                        whileHover={
                          valid && !loading && !reduced ? { y: -1 } : undefined
                        }
                        whileTap={
                          valid && !loading && !reduced
                            ? { scale: 0.98 }
                            : undefined
                        }
                        transition={{
                          type: "tween",
                          duration: MOTION_DURATIONS.control,
                          ease: MOTION_EASE,
                        }}
                      >
                        {formatDuration(duration)}
                      </motion.button>
                    );
                  })}
                </div>
              </fieldset>
            </div>
            <div
              className="selection-summary"
              id="selection-summary"
              role="status"
              aria-live="polite"
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={`${selection.start}-${selection.end}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: reduced ? MOTION_DURATIONS.reduced : 0.16,
                    ease: MOTION_EASE,
                  }}
                >
                  {selection.start === null ? (
                    "Select an available start time, then choose a duration."
                  ) : selection.end === null ? (
                    <>
                      <strong>{slotToTime(selection.start)}</strong> selected ·
                      Choose a duration.
                    </>
                  ) : (
                    <>
                      <strong>
                        {slotToTime(selection.start)}–
                        {slotToTime(selection.end)}
                      </strong>{" "}
                      ·{" "}
                      {formatDuration(
                        (selection.end - selection.start) * SLOT_MINUTES,
                      )}
                    </>
                  )}
                </motion.span>
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

interface BookingPageProps {
  rooms: Room[];
  roomsLoading: boolean;
  selection: Selection;
  busy: BusyInterval[];
  availabilityLoading: boolean;
  availabilityError: string;
  dateWindowAnchor: string;
  reduced: boolean;
  variants: MotionVariantCollection;
  onChooseDate: (date: string) => void;
  onDateWindowAnchor: (date: string) => void;
  onChooseRoom: (roomId: string) => void;
  onChooseStart: (slot: number) => void;
  onChooseDuration: (duration: number) => void;
  onGuidelines: (roomId: string, opener: HTMLElement) => void;
  onContinue: (opener: HTMLElement) => void;
}

function BookingPage({
  rooms,
  roomsLoading,
  selection,
  busy,
  availabilityLoading,
  availabilityError,
  dateWindowAnchor,
  reduced,
  variants,
  onChooseDate,
  onDateWindowAnchor,
  onChooseRoom,
  onChooseStart,
  onChooseDuration,
  onGuidelines,
  onContinue,
}: BookingPageProps) {
  const selectedRoom = rooms.find((room) => room.id === selection.room);
  const complete = Boolean(
    selection.date &&
      selectedRoom &&
      selection.start !== null &&
      selection.end !== null,
  );
  return (
    <div id="booking-view">
      <section className="hero">
        <div>
          <p className="eyebrow">ROOM AVAILABILITY</p>
          <h1>Book a meeting room</h1>
          <p>
            Choose a date, room or workspace, start time, and duration. No account
            required.
          </p>
        </div>
        <div className="office-hours">
          <span className="status-dot" />
          Office hours <strong>8:00 AM–6:00 PM</strong>
        </div>
      </section>
      <ProgressSteps selection={selection} />
      <DateSelector
        selection={selection}
        windowAnchor={dateWindowAnchor}
        reduced={reduced}
        onChoose={onChooseDate}
        onWindowAnchor={onDateWindowAnchor}
      />
      <RoomGrid
        rooms={rooms}
        selection={selection}
        busy={busy}
        loading={availabilityLoading}
        roomsLoading={roomsLoading}
        reduced={reduced}
        variants={variants}
        onChoose={onChooseRoom}
        onGuidelines={onGuidelines}
      />
      <TimePanel
        rooms={rooms}
        selection={selection}
        busy={busy}
        loading={availabilityLoading}
        availabilityError={availabilityError}
        reduced={reduced}
        variants={variants}
        onChooseStart={onChooseStart}
        onChooseDuration={onChooseDuration}
      />
      <div className="continue-bar">
        <p id="continue-hint" aria-live="polite">
          {complete && selectedRoom
            ? `${selectedRoom.name} · ${formatDate(selection.date)} · ${slotToTime(
                selection.start as number,
              )}–${slotToTime(selection.end as number)}`
            : "Select a date, room, start time, and duration to continue."}
        </p>
        <motion.button
          className="primary-button"
          id="continue-button"
          disabled={!complete || availabilityLoading}
          onClick={(event) => onContinue(event.currentTarget)}
          {...buttonMotion(reduced, complete && !availabilityLoading)}
        >
          Continue to details <span>→</span>
        </motion.button>
      </div>
    </div>
  );
}

interface AnimatedBackdropProps {
  id: string;
  open: boolean;
  variants: Variants;
  onClick: () => void;
}

function AnimatedBackdrop({
  id,
  open,
  variants,
  onClick,
}: AnimatedBackdropProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  return (
    <motion.div
      ref={backdropRef}
      className="drawer-backdrop"
      id={id}
      aria-hidden="true"
      initial="hidden"
      animate={open ? "visible" : "exit"}
      variants={variants}
      onAnimationComplete={() => {
        if (!open && backdropRef.current) {
          backdropRef.current.style.visibility = "hidden";
        }
      }}
      onClick={onClick}
      style={{
        pointerEvents: open ? "auto" : "none",
        visibility: open ? "visible" : undefined,
      }}
    />
  );
}

interface AnimatedDrawerProps {
  id: string;
  className?: string;
  open: boolean;
  labelledBy: string;
  variants: Variants;
  children: React.ReactNode;
}

function AnimatedDrawer({
  id,
  className = "",
  open,
  labelledBy,
  variants,
  children,
}: AnimatedDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  return (
    <motion.aside
      ref={drawerRef}
      className={`drawer ${className} ${open ? "open" : ""}`.trim()}
      id={id}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby={labelledBy}
      inert={!open ? true : undefined}
      initial="hidden"
      animate={open ? "visible" : "exit"}
      variants={variants}
      onAnimationComplete={() => {
        if (!open && drawerRef.current) {
          drawerRef.current.style.visibility = "hidden";
        }
      }}
      style={{
        pointerEvents: open ? "auto" : "none",
        visibility: open ? "visible" : undefined,
      }}
    >
      {children}
    </motion.aside>
  );
}

function LoadingButtonLabel({
  loading,
  loadingLabel,
  idleLabel,
  reduced,
  variants,
}: {
  loading: boolean;
  loadingLabel: string;
  idleLabel: string;
  reduced: boolean;
  variants: MotionVariantCollection;
}) {
  return (
    <span className="button-label-frame" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          className="button-label"
          key={loading ? "loading" : "idle"}
          variants={variants.buttonLabel}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          {loading && (
            <motion.span
              className="button-spinner"
              aria-hidden="true"
              animate={reduced ? undefined : { rotate: 360 }}
              transition={
                reduced
                  ? undefined
                  : { duration: 0.8, ease: "linear", repeat: Infinity }
              }
            />
          )}
          {loading ? loadingLabel : idleLabel}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

interface DetailsDrawerProps {
  open: boolean;
  room?: Room;
  selection: Selection;
  busy: BusyInterval[];
  availabilityLoading: boolean;
  availabilityError: string;
  draft: BookingDraft;
  editing: boolean;
  submitting: boolean;
  formError: string;
  reduced: boolean;
  variants: MotionVariantCollection;
  onDraft: (next: BookingDraft) => void;
  onChooseDate: (date: string) => void;
  onChooseStart: (slot: number) => void;
  onChooseDuration: (duration: number) => void;
  onRetryAvailability: () => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

function DetailsDrawer({
  open,
  room,
  selection,
  busy,
  availabilityLoading,
  availabilityError,
  draft,
  editing,
  submitting,
  formError,
  reduced,
  variants,
  onDraft,
  onChooseDate,
  onChooseStart,
  onChooseDuration,
  onRetryAvailability,
  onClose,
  onSubmit,
}: DetailsDrawerProps) {
  const duration =
    selection.start !== null && selection.end !== null
      ? (selection.end - selection.start) * SLOT_MINUTES
      : 0;
  const { minimum: minimumDate, maximum: maximumDate } = dateBounds();
  const scheduleComplete =
    selection.start !== null &&
    selection.end !== null &&
    duration > 0 &&
    !availabilityLoading &&
    !availabilityError;
  const cleanupRule = room?.guidelines.at(-1) || "";
  const reminder = room
    ? `${room.compactDescription} ${durationPolicy(room)} ${cleanupRule}`
    : "";
  const bookedBy = draft.name.trim() || "Not entered";
  const scheduleStatus = availabilityLoading
    ? "Checking availability…"
    : availabilityError
      ? availabilityError
      : selection.start === null
        ? "Choose an available start time."
        : selection.end === null
          ? "Choose how long the booking should be."
          : `${formatDate(selection.date)} · ${slotToTime(
              selection.start,
            )}–${slotToTime(selection.end)}`;
  return (
    <>
      <AnimatedBackdrop
        id="drawer-backdrop"
        open={open}
        variants={variants.backdrop}
        onClick={onClose}
      />
      <AnimatedDrawer
        id="details-drawer"
        open={open}
        labelledBy="drawer-title"
        variants={variants.desktopDrawer}
      >
        <div className="drawer-header">
          <div>
            <p className="eyebrow">BOOKING DETAILS</p>
            <h2 id="drawer-title">
              {editing ? "Edit your booking" : "Complete your booking"}
            </h2>
          </div>
          <motion.button
            className="icon-button"
            id="close-drawer"
            aria-label="Close"
            type="button"
            onClick={onClose}
            {...buttonMotion(reduced)}
          >
            ×
          </motion.button>
        </div>
        <form id="booking-form" noValidate onSubmit={onSubmit}>
          <div className="drawer-body">
            <div className="booking-summary" id="drawer-summary">
              <dl>
                <dt>Room</dt>
                <dd>{room?.name || ""}</dd>
                {room?.location && (
                  <>
                    <dt>Location</dt>
                    <dd>{room.location}</dd>
                  </>
                )}
                <dt>Date</dt>
                <dd>{selection.date ? formatDate(selection.date, true) : ""}</dd>
                <dt>Time</dt>
                <dd>
                  {selection.start !== null && selection.end !== null
                    ? `${slotToTime(selection.start)}–${slotToTime(selection.end)}`
                    : ""}
                </dd>
                <dt>Duration</dt>
                <dd>{duration ? formatDuration(duration) : ""}</dd>
                <dt>Booking team</dt>
                <dd>{organizerGroupLabel(draft.organizerGroup)}</dd>
                <dt>Booked by</dt>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.dd
                    id="summary-booked-by"
                    key={bookedBy}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{
                      duration: reduced ? MOTION_DURATIONS.reduced : 0.14,
                      ease: MOTION_EASE,
                    }}
                  >
                    {bookedBy}
                  </motion.dd>
                </AnimatePresence>
                <dt>Attendees</dt>
                <dd>{draft.attendees.trim() || "Not entered"}</dd>
              </dl>
            </div>
            {editing && room && (
              <fieldset
                className="edit-schedule"
                disabled={submitting}
                aria-busy={availabilityLoading}
                aria-describedby="edit-schedule-status"
              >
                <legend>Change date or time</legend>
                <div className="edit-schedule-grid">
                  <label className="edit-date-field">
                    Date
                    <input
                      id="edit-date"
                      type="date"
                      min={minimumDate}
                      max={maximumDate}
                      value={selection.date}
                      onClick={(event) =>
                        openNativeDatePicker(event.currentTarget)
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        if (
                          typeof event.currentTarget.showPicker !== "function"
                        ) {
                          return;
                        }
                        event.preventDefault();
                        openNativeDatePicker(event.currentTarget);
                      }}
                      onChange={(event) => {
                        if (event.target.value) {
                          onChooseDate(event.target.value);
                        }
                      }}
                    />
                  </label>
                  <label>
                    Start time
                    <select
                      id="edit-start"
                      value={selection.start ?? ""}
                      disabled={
                        availabilityLoading || Boolean(availabilityError)
                      }
                      onChange={(event) =>
                        onChooseStart(Number(event.target.value))
                      }
                    >
                      <option value="" disabled>
                        Select a time
                      </option>
                      {Array.from({ length: TOTAL_SLOTS }, (_, slot) => {
                        const available = durationOptions(room).some(
                          (optionDuration) =>
                            durationIsAvailable(
                              room,
                              selection.date,
                              busy,
                              slot,
                              optionDuration,
                            ),
                        );
                        return (
                          <option value={slot} disabled={!available} key={slot}>
                            {slotToTime(slot)}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label>
                    Duration
                    <select
                      id="edit-duration"
                      value={duration || ""}
                      disabled={
                        availabilityLoading ||
                        Boolean(availabilityError) ||
                        selection.start === null
                      }
                      onChange={(event) =>
                        onChooseDuration(Number(event.target.value))
                      }
                    >
                      <option value="" disabled>
                        Select duration
                      </option>
                      {durationOptions(room).map((optionDuration) => {
                        const available =
                          selection.start !== null &&
                          durationIsAvailable(
                            room,
                            selection.date,
                            busy,
                            selection.start,
                            optionDuration,
                          );
                        return (
                          <option
                            value={optionDuration}
                            disabled={!available}
                            key={optionDuration}
                          >
                            {formatDuration(optionDuration)}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>
                <div className="edit-schedule-feedback">
                  <p
                    className={`edit-schedule-status ${
                      availabilityError ? "error" : ""
                    }`}
                    id="edit-schedule-status"
                    role={availabilityError ? "alert" : "status"}
                    aria-live="polite"
                  >
                    {scheduleStatus}
                  </p>
                  {availabilityError && (
                    <motion.button
                      className="schedule-retry-button"
                      type="button"
                      onClick={onRetryAvailability}
                      {...buttonMotion(reduced, !submitting)}
                    >
                      Retry
                    </motion.button>
                  )}
                </div>
              </fieldset>
            )}
            <label>
              Booking team <span>*</span>
              <select
                name="organizerGroup"
                required
                value={draft.organizerGroup}
                onChange={(event) =>
                  onDraft({
                    ...draft,
                    organizerGroup: event.target.value as OrganizerGroup,
                  })
                }
              >
                <option value="PLAYBOOK">PLAYBOOK</option>
                <option value="O&H">O&amp;H</option>
                <option value="Joint">PLAYBOOK &amp; O&amp;H</option>
              </select>
            </label>
            <label>
              Booked by <span>*</span>
              <input
                name="name"
                required
                maxLength={80}
                placeholder="Your full name"
                value={draft.name}
                onChange={(event) =>
                  onDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label>
              Organizer email <small>Optional</small>
              <input
                name="email"
                type="email"
                maxLength={120}
                placeholder="name@company.com"
                value={draft.email}
                onChange={(event) =>
                  onDraft({ ...draft, email: event.target.value })
                }
              />
            </label>
            <label>
              Meeting title or booking purpose <span>*</span>
              <input
                name="title"
                required
                maxLength={100}
                placeholder="e.g. Weekly product meeting"
                value={draft.title}
                onChange={(event) =>
                  onDraft({ ...draft, title: event.target.value })
                }
              />
            </label>
            <label>
              Attendees <span>*</span>
              <textarea
                name="attendees"
                required
                maxLength={500}
                rows={3}
                placeholder="Names or email addresses; enter Solo if no other attendees"
                value={draft.attendees}
                onChange={(event) =>
                  onDraft({ ...draft, attendees: event.target.value })
                }
              />
            </label>
            <label>
              Notes <small>Optional</small>
              <textarea
                name="notes"
                maxLength={500}
                rows={4}
                placeholder="Add an agenda, preparation, or access notes"
                value={draft.notes}
                onChange={(event) =>
                  onDraft({ ...draft, notes: event.target.value })
                }
              />
            </label>
            <div className="room-reminder" id="room-reminder">
              <strong>Room reminder</strong>
              {reminder}
            </div>
            <AnimatePresence initial={false}>
              {formError && (
                <motion.div
                  className="form-error"
                  id="form-error"
                  role="alert"
                  aria-live="assertive"
                  tabIndex={-1}
                  variants={variants.error}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {formError}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="drawer-footer">
            <motion.button
              type="button"
              className="secondary-button"
              id="cancel-drawer"
              onClick={onClose}
              {...buttonMotion(reduced)}
            >
              Cancel
            </motion.button>
            <motion.button
              type="submit"
              className="primary-button loading-button"
              id="confirm-button"
              disabled={submitting || (editing && !scheduleComplete)}
              {...buttonMotion(
                reduced,
                !submitting && (!editing || scheduleComplete),
              )}
            >
              <LoadingButtonLabel
                loading={submitting}
                loadingLabel={editing ? "Saving changes" : "Creating booking"}
                idleLabel={editing ? "Save changes" : "Confirm booking"}
                reduced={reduced}
                variants={variants}
              />
            </motion.button>
          </div>
        </form>
      </AnimatedDrawer>
    </>
  );
}

interface GuidelinesDrawerProps {
  open: boolean;
  room?: Room;
  reduced: boolean;
  variants: MotionVariantCollection;
  onClose: () => void;
}

function GuidelinesDrawer({
  open,
  room,
  reduced,
  variants,
  onClose,
}: GuidelinesDrawerProps) {
  return (
    <>
      <AnimatedBackdrop
        id="guidelines-backdrop"
        open={open}
        variants={variants.backdrop}
        onClick={onClose}
      />
      <AnimatedDrawer
        id="guidelines-drawer"
        className="guidelines-drawer"
        open={open}
        labelledBy="guidelines-title"
        variants={variants.drawer}
      >
        <div className="drawer-header">
          <div>
            <p className="eyebrow">ROOM GUIDELINES</p>
            <h2 id="guidelines-title" tabIndex={-1}>
              {room?.name || "Room guidelines"}
            </h2>
          </div>
          <motion.button
            className="icon-button"
            id="close-guidelines"
            aria-label="Close room guidelines"
            type="button"
            onClick={onClose}
            {...buttonMotion(reduced)}
          >
            ×
          </motion.button>
        </div>
        <div className="guidelines-body" id="guidelines-body">
          {room && (
            <>
              <section className="guidelines-section">
                <h3>Purpose</h3>
                <p>{room.purpose}</p>
              </section>
              <section className="guidelines-section">
                <h3>Recommended uses</h3>
                <ul>
                  {room.recommendedUses.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
              <section className="guidelines-section">
                <h3>Booking duration</h3>
                <p>{durationPolicy(room)}</p>
              </section>
              <section className="guidelines-section">
                <h3>Usage rules</h3>
                <ul>
                  {room.guidelines.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
        <div className="drawer-footer">
          <motion.button
            type="button"
            className="secondary-button"
            id="done-guidelines"
            onClick={onClose}
            {...buttonMotion(reduced)}
          >
            Close
          </motion.button>
        </div>
      </AnimatedDrawer>
    </>
  );
}

function RouteLoading({ reduced }: { reduced: boolean }) {
  return (
    <div className={`route-loading ${reduced ? "reduced" : ""}`} role="status">
      <span className="route-loading-line" />
      <span className="route-loading-line short" />
      <span className="sr-only">Loading booking…</span>
    </div>
  );
}

interface ConfirmationProps {
  item: Booking;
  token: string;
  reduced: boolean;
  variants: MotionVariantCollection;
  cancelling: boolean;
  copied: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onNew: () => void;
}

function Confirmation({
  item,
  token,
  reduced,
  variants,
  cancelling,
  copied,
  onCopy,
  onEdit,
  onCancel,
  onNew,
}: ConfirmationProps) {
  const cancelled = item.status === "cancelled";
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [item.reference, item.status]);
  return (
    <motion.section
      className="confirmation"
      variants={variants.confirmation}
      initial="hidden"
      animate="visible"
      exit="exit"
      key={`${item.reference}-${item.status}`}
    >
      <motion.div className="confirmation-top" variants={variants.confirmationItem}>
        <motion.div
          className={`confirm-icon ${cancelled ? "cancelled" : ""}`}
          aria-hidden="true"
          variants={variants.confirmationIcon}
        >
          {cancelled ? "×" : "✓"}
        </motion.div>
        <p className="eyebrow">
          {cancelled ? "BOOKING CANCELLED" : "BOOKING CONFIRMED"}
        </p>
        <h1 id="confirmation-title" ref={headingRef} tabIndex={-1}>
          {cancelled ? "This booking was cancelled" : "Booking confirmed"}
        </h1>
        <p>
          {cancelled
            ? "The selected time is available again."
            : "Keep the private link below to edit or cancel this booking."}
        </p>
      </motion.div>
      <motion.div
        className="confirmation-details"
        variants={variants.confirmationItem}
      >
        <h2>{item.roomName}</h2>
        {item.location && <p>{item.location}</p>}
        <p>{formatDate(item.date, true)}</p>
        <p>
          <strong>
            {slotToTime(item.start)}–{slotToTime(item.end)}
          </strong>
        </p>
        <p>Duration: {formatDuration(item.durationMinutes)}</p>
        <p>
          {organizerGroupLabel(item.organizerGroup)} · Owner: {item.bookedBy}
        </p>
        {item.email && <p>Organizer email: {item.email}</p>}
        <p>
          <strong>{item.meetingTitle}</strong>
        </p>
        <p>Attendees: {item.attendees}</p>
        <div className="reference">
          <span>BOOKING REFERENCE</span>
          <strong>{item.reference}</strong>
        </div>
      </motion.div>
      {!cancelled && (
        <motion.div className="private-link" variants={variants.confirmationItem}>
          <label htmlFor="private-link-input">Private management link</label>
          <div className="private-link-row">
            <input
              id="private-link-input"
              type="text"
              readOnly
              aria-describedby="private-link-note"
              value={`${window.location.origin}/booking/${token}`}
            />
            <motion.button
              type="button"
              className="secondary-button copy-button"
              id="copy-link"
              onClick={onCopy}
              {...buttonMotion(reduced)}
            >
              {copied ? "Copied" : "Copy link"}
            </motion.button>
          </div>
        </motion.div>
      )}
      <motion.div
        className="confirmation-actions"
        variants={variants.confirmationItem}
      >
        {cancelled ? (
          <motion.button
            type="button"
            className="primary-button"
            id="new-booking"
            onClick={onNew}
            {...buttonMotion(reduced)}
          >
            Book another room
          </motion.button>
        ) : (
          <>
            <motion.button
              type="button"
              className="secondary-button"
              id="edit-booking"
              onClick={onEdit}
              {...buttonMotion(reduced)}
            >
              Edit booking
            </motion.button>
            <motion.button
              type="button"
              className="danger-link loading-button cancel-loading-button"
              id="cancel-booking"
              disabled={cancelling}
              onClick={onCancel}
              {...buttonMotion(reduced, !cancelling)}
            >
              <LoadingButtonLabel
                loading={cancelling}
                loadingLabel="Cancelling"
                idleLabel="Cancel booking"
                reduced={reduced}
                variants={variants}
              />
            </motion.button>
          </>
        )}
      </motion.div>
      {!cancelled && (
        <motion.p
          className="private-note"
          id="private-link-note"
          variants={variants.confirmationItem}
        >
          Anyone with this link can edit or cancel the booking. Keep it private
          and do not share it publicly.
        </motion.p>
      )}
    </motion.section>
  );
}

function MissingBooking({
  message,
  reduced,
  variants,
  onNew,
}: {
  message: string;
  reduced: boolean;
  variants: MotionVariantCollection;
  onNew: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <motion.section
      className="confirmation"
      variants={variants.confirmation}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div className="confirmation-top" variants={variants.confirmationItem}>
        <h1 id="confirmation-title" ref={headingRef} tabIndex={-1}>
          Booking not found
        </h1>
        <p>
          {message ||
            "This private link is invalid or the booking is no longer available."}
        </p>
      </motion.div>
      <motion.div
        className="confirmation-actions"
        variants={variants.confirmationItem}
      >
        <motion.button
          type="button"
          className="primary-button"
          id="new-booking"
          onClick={onNew}
          {...buttonMotion(reduced)}
        >
          Book a room
        </motion.button>
      </motion.div>
    </motion.section>
  );
}

function ServiceError({
  message,
  reduced,
  variants,
}: {
  message: string;
  reduced: boolean;
  variants: MotionVariantCollection;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <motion.section
      className="confirmation"
      variants={variants.confirmation}
      initial="hidden"
      animate="visible"
    >
      <motion.div className="confirmation-top" variants={variants.confirmationItem}>
        <p className="eyebrow">SERVICE UNAVAILABLE</p>
        <h1 ref={headingRef} tabIndex={-1}>
          The booking service is not available
        </h1>
        <p>{message} Start the application server and try again.</p>
      </motion.div>
      <motion.div
        className="confirmation-actions"
        variants={variants.confirmationItem}
      >
        <motion.button
          type="button"
          className="primary-button"
          id="retry-service"
          onClick={() => window.location.reload()}
          {...buttonMotion(reduced)}
        >
          Try again
        </motion.button>
      </motion.div>
    </motion.section>
  );
}

function App() {
  const reduced = Boolean(useReducedMotion());
  const mobile = useIsMobile();
  const variants = useMemo(
    () => makeMotionVariants(reduced, mobile),
    [reduced, mobile],
  );
  const initialWindowAnchor = useMemo(() => dateBounds().minimum, []);
  const initialDate = useMemo(
    () => nextBookableDate(initialWindowAnchor),
    [initialWindowAnchor],
  );
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [selection, setSelection] = useState<Selection>({
    date: initialDate,
    room: "",
    start: null,
    end: null,
  });
  const [dateWindowAnchor, setDateWindowAnchor] =
    useState(initialWindowAnchor);
  const [busy, setBusy] = useState<BusyInterval[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [availabilityError, setAvailabilityError] = useState("");
  const [page, setPage] = useState<PageMode>("booking");
  const [dialog, setDialog] = useState<DialogType>(null);
  const [guidelinesRoomId, setGuidelinesRoomId] = useState("");
  const [draft, setDraft] = useState<BookingDraft>({
    name: "",
    organizerGroup: "PLAYBOOK",
    attendees: "",
    email: "",
    title: "",
    notes: "",
  });
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [managedBooking, setManagedBooking] = useState<Booking | null>(null);
  const [managementToken, setManagementToken] = useState("");
  const [managedError, setManagedError] = useState("");
  const [routeLoading, setRouteLoading] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const availabilityRequest = useRef(0);
  const lastFocusedElement = useRef<HTMLElement | null>(null);
  const selectionRef = useRef(selection);
  const roomsRef = useRef(rooms);
  const busyRef = useRef(busy);
  const pageRef = useRef(page);
  const editingTokenRef = useRef(editingToken);
  const submittingRef = useRef(submitting);

  useEffect(() => {
    selectionRef.current = selection;
    roomsRef.current = rooms;
    busyRef.current = busy;
    pageRef.current = page;
    editingTokenRef.current = editingToken;
    submittingRef.current = submitting;
  }, [busy, editingToken, page, rooms, selection, submitting]);

  const showToast = useCallback((message: string) => {
    setToast({ id: Date.now(), message });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const loadAvailability = useCallback(
    async (date: string, token: string | null = null): Promise<BusyInterval[]> => {
      const requestId = ++availabilityRequest.current;
      setAvailabilityLoading(true);
      setAvailabilityError("");
      try {
        const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : "";
        const result = await api<{ busy?: BusyInterval[] }>(
          `/api/availability?date=${encodeURIComponent(date)}${tokenQuery}`,
        );
        const intervals = Array.isArray(result.busy) ? result.busy : [];
        if (requestId === availabilityRequest.current) {
          setBusy(intervals);
          setAvailabilityLoading(false);
        }
        return intervals;
      } catch (error) {
        const requestError = error as ApiError;
        if (requestId === availabilityRequest.current) {
          setAvailabilityLoading(false);
          setAvailabilityError(requestError.message);
        }
        return busyRef.current;
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let realtimeClient: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    let refreshTimer = 0;

    const subscribe = async () => {
      try {
        const config = await api<RealtimeConfig>("/api/realtime-config");
        if (
          !active ||
          !config.enabled ||
          !config.url ||
          !config.publishableKey
        ) {
          return;
        }
        realtimeClient = createClient(config.url, config.publishableKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        });
        channel = realtimeClient
          .channel("room-availability")
          .on(
            "broadcast",
            { event: "availability_changed" },
            ({ payload }) => {
              if (
                !active ||
                pageRef.current !== "booking" ||
                submittingRef.current ||
                !payload ||
                typeof payload.date !== "string" ||
                payload.date !== selectionRef.current.date
              ) {
                return;
              }
              window.clearTimeout(refreshTimer);
              refreshTimer = window.setTimeout(async () => {
                const current = selectionRef.current;
                const intervals = await loadAvailability(
                  current.date,
                  editingTokenRef.current,
                );
                const latest = selectionRef.current;
                if (
                  latest.date === current.date &&
                  latest.start !== null &&
                  latest.end !== null &&
                  conflictFor(
                    intervals,
                    latest.room,
                    latest.start,
                    latest.end,
                  )
                ) {
                  setSelection((value) => ({
                    ...value,
                    start: null,
                    end: null,
                  }));
                  showToast(
                    "Availability changed. Choose another start time.",
                  );
                }
              }, 80);
            },
          )
          .subscribe();
      } catch {
        return;
      }
    };

    void subscribe();
    return () => {
      active = false;
      window.clearTimeout(refreshTimer);
      if (realtimeClient && channel) {
        void realtimeClient.removeChannel(channel);
      }
    };
  }, [loadAvailability, showToast]);

  const loadManagedBooking = useCallback(async (token: string) => {
    setPage("manage");
    setDialog(null);
    setEditingToken(null);
    setManagementToken(token);
    setManagedBooking(null);
    setManagedError("");
    setRouteLoading(true);
    try {
      const result = await api<{ booking: Booking }>(`/api/bookings/${token}`);
      setManagedBooking(result.booking);
    } catch (error) {
      setManagedError((error as ApiError).message);
    } finally {
      setRouteLoading(false);
    }
  }, []);

  const resetBookingFlow = useCallback(
    (historyMode: "push" | "replace" | "none" = "none") => {
      const windowAnchor = dateBounds().minimum;
      const nextDate = nextBookableDate(windowAnchor);
      if (historyMode === "push") history.pushState({}, "", "/book");
      if (historyMode === "replace") history.replaceState({}, "", "/book");
      setSelection({ date: nextDate, room: "", start: null, end: null });
      setDateWindowAnchor(windowAnchor);
      setBusy([]);
      setEditingToken(null);
      setManagedBooking(null);
      setManagedError("");
      setManagementToken("");
      setDialog(null);
      setDraft({
        name: "",
        organizerGroup: "PLAYBOOK",
        attendees: "",
        email: "",
        title: "",
        notes: "",
      });
      setFormError("");
      setPage("booking");
      setCopied(false);
      void loadAvailability(nextDate);
    },
    [loadAvailability],
  );

  useEffect(() => {
    let active = true;
    const initialise = async () => {
      try {
        const result = await api<{ rooms?: Room[] }>("/api/rooms");
        if (!active) return;
        const catalogue = Array.isArray(result.rooms) ? result.rooms : [];
        if (catalogue.length !== 4) {
          throw new Error("The room catalogue is not available.");
        }
        setRooms(catalogue);
        setRoomsLoading(false);
        const match = window.location.pathname.match(
          /^\/booking\/([a-f0-9]{48})$/,
        );
        if (match) {
          await loadManagedBooking(match[1]!);
          return;
        }
        if (!["/", "/book", "/book/details"].includes(window.location.pathname)) {
          history.replaceState({}, "", "/book");
        }
        if (window.location.pathname === "/book/details") {
          history.replaceState({}, "", "/book");
        }
        setPage("booking");
        await loadAvailability(initialDate);
      } catch (error) {
        if (!active) return;
        setRoomsLoading(false);
        setServiceError((error as Error).message);
        setPage("service");
      }
    };
    void initialise();
    return () => {
      active = false;
    };
  }, [initialDate, loadAvailability, loadManagedBooking]);

  useEffect(() => {
    const handlePopState = () => {
      const match = window.location.pathname.match(
        /^\/booking\/([a-f0-9]{48})$/,
      );
      if (match) {
        void loadManagedBooking(match[1]!);
        return;
      }
      if (window.location.pathname === "/book/details") {
        const valid = !selectionError(
          selectionRef.current,
          roomsRef.current,
          busyRef.current,
        );
        if (valid) {
          setPage("booking");
          setDialog("details");
          return;
        }
        history.replaceState({}, "", "/book");
      }
      if (page === "manage") {
        resetBookingFlow("none");
      } else {
        setDialog(null);
        setPage("booking");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [loadManagedBooking, page, resetBookingFlow]);

  useEffect(() => {
    if (page === "manage" && managedBooking) {
      document.title = `${
        managedBooking.status === "cancelled" ? "Cancelled" : "Confirmed"
      } · ${managedBooking.reference} · Playbook`;
    } else {
      document.title = "Playbook Office Rooms";
    }
  }, [managedBooking, page]);

  useEffect(() => {
    if (!dialog) return;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.inert = true;
    document.body.style.overflow = "hidden";
    let focusTimer = 0;
    let focusAttempts = 0;
    const focusDialog = () => {
      const target =
        dialog === "details"
          ? editingToken
            ? document.querySelector<HTMLInputElement>("#edit-date")
            : document.querySelector<HTMLInputElement>(
                "#booking-form input[name=name]",
              )
          : document.querySelector<HTMLElement>("#guidelines-title");
      const focusBlocked =
        !target ||
        Boolean(target.closest("[inert]")) ||
        getComputedStyle(target).visibility === "hidden";
      if (focusBlocked && focusAttempts < 12) {
        focusAttempts += 1;
        focusTimer = window.setTimeout(focusDialog, reduced ? 0 : 16);
        return;
      }
      target?.focus();
    };
    focusTimer = window.setTimeout(focusDialog, 0);
    return () => {
      window.clearTimeout(focusTimer);
      if (shell) shell.inert = false;
      document.body.style.overflow = "";
      const target = lastFocusedElement.current;
      requestAnimationFrame(() => {
        if (target?.isConnected && !target.closest("[inert]")) target.focus();
      });
    };
  }, [dialog, editingToken, reduced]);

  const closeDetails = useCallback(() => {
    const wasEditing = Boolean(editingToken);
    document.querySelector("#details-drawer")?.setAttribute("inert", "");
    document
      .querySelector("#details-drawer")
      ?.setAttribute("aria-hidden", "true");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.inert = false;
    document.body.style.overflow = "";
    setDialog(null);
    setFormError("");
    if (!wasEditing && window.location.pathname === "/book/details") {
      history.replaceState({}, "", "/book");
    }
    if (wasEditing) {
      setEditingToken(null);
      setPage("manage");
    }
    const target = lastFocusedElement.current;
    if (target?.isConnected && !target.closest("[inert]")) target.focus();
  }, [editingToken]);

  const closeGuidelines = useCallback(() => {
    document.querySelector("#guidelines-drawer")?.setAttribute("inert", "");
    document
      .querySelector("#guidelines-drawer")
      ?.setAttribute("aria-hidden", "true");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.inert = false;
    document.body.style.overflow = "";
    setDialog(null);
    const target = lastFocusedElement.current;
    if (target?.isConnected && !target.closest("[inert]")) target.focus();
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dialog === "details") closeDetails();
        else closeGuidelines();
        return;
      }
      if (event.key !== "Tab") return;
      const selector =
        dialog === "details" ? "#details-drawer" : "#guidelines-drawer";
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          `${selector} button:not(:disabled), ${selector} input:not(:disabled), ${selector} select:not(:disabled), ${selector} textarea:not(:disabled), ${selector} [tabindex]:not([tabindex="-1"])`,
        ),
      ].filter(
        (element) =>
          !element.hasAttribute("inert") &&
          element.getClientRects().length > 0,
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [closeDetails, closeGuidelines, dialog]);

  useEffect(() => {
    const handleFocus = () => {
      if (page === "booking" && !dialog) {
        void loadAvailability(selectionRef.current.date, editingToken);
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [dialog, editingToken, loadAvailability, page]);

  const chooseDate = async (date: string) => {
    if (isWeekendDate(date)) {
      showToast(WEEKEND_CLOSED_MESSAGE);
      return;
    }
    if (!isDateAllowed(date)) {
      showToast(`Choose a date within the next ${BOOKING_WINDOW_DAYS} days.`);
      return;
    }
    setFormError("");
    setSelection((current) => ({
      ...current,
      date,
      start: null,
      end: null,
    }));
    await loadAvailability(date, editingToken);
  };

  const chooseRoom = (roomId: string) => {
    const room = rooms.find((candidate) => candidate.id === roomId);
    if (
      !room ||
      roomHasAvailability(
        room,
        selection.date,
        busy,
        availabilityLoading,
      ) !== true
    ) {
      return;
    }
    setSelection((current) => ({
      ...current,
      room: roomId,
      start: null,
      end: null,
    }));
    requestAnimationFrame(() => {
      document.querySelector(".time-panel")?.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "nearest",
      });
    });
  };

  const chooseStart = (slot: number) => {
    const room = rooms.find((candidate) => candidate.id === selection.room);
    if (
      !room ||
      availabilityLoading ||
      Boolean(availabilityError) ||
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= TOTAL_SLOTS ||
      !durationOptions(room).some((duration) =>
        durationIsAvailable(
          room,
          selection.date,
          busy,
          slot,
          duration,
        ),
      )
    ) {
      return;
    }
    setFormError("");
    flushSync(() => {
      setSelection((current) => ({ ...current, start: slot, end: null }));
    });
  };

  const chooseDuration = (duration: number) => {
    const room = rooms.find((candidate) => candidate.id === selection.room);
    if (
      !room ||
      selection.start === null ||
      !durationIsAvailable(
        room,
        selection.date,
        busy,
        selection.start,
        duration,
      )
    ) {
      return;
    }
    setFormError("");
    flushSync(() => {
      setSelection((current) => ({
        ...current,
        end: (current.start as number) + duration / SLOT_MINUTES,
      }));
    });
  };

  const openGuidelines = (
    roomId: string,
    opener: HTMLElement,
  ) => {
    if (!rooms.find((room) => room.id === roomId)) return;
    lastFocusedElement.current = opener;
    setGuidelinesRoomId(roomId);
    setDialog("guidelines");
  };

  const openDetails = (opener: HTMLElement) => {
    const error = selectionError(selection, rooms, busy);
    if (error) {
      showToast(error);
      return;
    }
    lastFocusedElement.current = opener;
    setFormError("");
    if (!editingToken && window.location.pathname !== "/book/details") {
      history.pushState({}, "", "/book/details");
    }
    setDialog("details");
  };

  const showFormError = (message: string) => {
    setFormError(message);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("#form-error")?.focus();
    });
  };

  const confirmBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (availabilityLoading) {
      showFormError("Wait while availability is being checked.");
      return;
    }
    if (availabilityError) {
      showFormError(
        "Availability could not be checked. Retry before saving the booking.",
      );
      return;
    }
    const error = selectionError(selection, rooms, busy);
    if (error) {
      showFormError(error);
      return;
    }
    const form = new FormData(event.currentTarget);
    const payload = {
      date: selection.date,
      room: selection.room,
      start: selection.start,
      end: selection.end,
      name: String(form.get("name") || "").trim(),
      organizerGroup: String(form.get("organizerGroup") || "").trim(),
      attendees: String(form.get("attendees") || "").trim(),
      email: String(form.get("email") || "").trim(),
      title: String(form.get("title") || "").trim(),
      notes: String(form.get("notes") || "").trim(),
    };
    if (
      !payload.name ||
      !payload.organizerGroup ||
      !payload.attendees ||
      !payload.title
    ) {
      showFormError(
        "Enter the booking team, owner, attendees, and meeting title or purpose.",
      );
      return;
    }
    if (
      payload.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
    ) {
      showFormError("Enter a valid organizer email address or leave it blank.");
      return;
    }

    setSubmitting(true);
    setFormError("");
    try {
      const token = editingToken;
      const result = await api<{ token?: string; booking: Booking }>(
        token ? `/api/bookings/${token}` : "/api/bookings",
        {
          method: token ? "PUT" : "POST",
          body: JSON.stringify(payload),
        },
      );
      const nextToken = result.token || token;
      if (!nextToken) throw new Error("The private booking link was not created.");
      document.querySelector("#details-drawer")?.setAttribute("inert", "");
      document
        .querySelector("#details-drawer")
        ?.setAttribute("aria-hidden", "true");
      setDialog(null);
      setEditingToken(null);
      setManagedBooking(result.booking);
      setManagementToken(nextToken);
      setManagedError("");
      setRouteLoading(false);
      setPage("manage");
      setCopied(false);
      if (token) {
        history.replaceState({}, "", `/booking/${nextToken}`);
      } else {
        history.replaceState({}, "", `/booking/${nextToken}`);
      }
    } catch (error) {
      const requestError = error as ApiError;
      if (requestError.status === 409) {
        showFormError(requestError.message);
        const intervals = await loadAvailability(selection.date, editingToken);
        if (
          selection.start !== null &&
          selection.end !== null &&
          conflictFor(
            intervals,
            selection.room,
            selection.start,
            selection.end,
          )
        ) {
          setSelection((current) => ({ ...current, start: null, end: null }));
        }
      } else {
        showFormError(requestError.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const editBooking = async () => {
    const item = managedBooking;
    if (!item || item.status === "cancelled") return;
    if (isWeekendDate(item.date)) {
      showToast(
        "This existing weekend booking cannot be edited, but it can still be cancelled.",
      );
      return;
    }
    if (!isDateAllowed(item.date) || isPastSlot(item.date, item.start)) {
      showToast("Past bookings can no longer be edited.");
      return;
    }
    const room = rooms.find((candidate) => candidate.id === item.room);
    if (!room?.isActive) {
      showToast(
        "This room is no longer active and the booking cannot be edited.",
      );
      return;
    }
    lastFocusedElement.current =
      document.querySelector<HTMLElement>("#edit-booking");
    setSelection({
      date: item.date,
      room: item.room,
      start: item.start,
      end: item.end,
    });
    setDateWindowAnchor(item.date);
    setDraft({
      name: item.bookedBy,
      organizerGroup: item.organizerGroup,
      attendees: item.attendees,
      email: item.email || "",
      title: item.meetingTitle,
      notes: item.notes || "",
    });
    setEditingToken(managementToken);
    setFormError("");
    setPage("booking");
    await loadAvailability(item.date, managementToken);
    setDialog("details");
  };

  const cancelBooking = async () => {
    const item = managedBooking;
    if (
      !item ||
      !window.confirm(
        `Cancel “${item.meetingTitle}”? This time will become available again.`,
      )
    ) {
      return;
    }
    setCancelling(true);
    try {
      const result = await api<{ booking: Booking }>(
        `/api/bookings/${managementToken}`,
        { method: "DELETE" },
      );
      setManagedBooking(result.booking);
    } catch (error) {
      showToast((error as ApiError).message);
    } finally {
      setCancelling(false);
    }
  };

  const copyPrivateLink = async () => {
    const value = `${window.location.origin}/booking/${managementToken}`;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.querySelector<HTMLInputElement>(
        "#private-link-input",
      );
      input?.select();
      document.execCommand("copy");
      input?.setSelectionRange(0, 0);
    }
    setCopied(true);
    showToast("Private management link copied.");
    window.setTimeout(() => setCopied(false), 1800);
  };

  const guidelinesRoom = rooms.find((room) => room.id === guidelinesRoomId);
  const selectedRoom = rooms.find((room) => room.id === selection.room);

  return (
    <MotionConfig
      transition={{
        type: "tween",
        duration: MOTION_DURATIONS.card,
        ease: MOTION_EASE,
      }}
      reducedMotion="user"
    >
      <div className="app-shell">
        <Header onHome={() => resetBookingFlow("push")} />
        <main>
          {page !== "booking" && (
            <div id="booking-view" className="hidden" aria-hidden="true" />
          )}
          {page === "booking" && (
            <section id="manage-view" className="hidden" aria-hidden="true" />
          )}
          <AnimatePresence mode="wait" initial>
            {page === "booking" && (
              <motion.div
                key="booking-page"
                data-motion-page="booking"
                variants={variants.page}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <BookingPage
                  rooms={rooms}
                  roomsLoading={roomsLoading}
                  selection={selection}
                  busy={busy}
                  availabilityLoading={availabilityLoading}
                  availabilityError={availabilityError}
                  dateWindowAnchor={dateWindowAnchor}
                  reduced={reduced}
                  variants={variants}
                  onChooseDate={(date) => void chooseDate(date)}
                  onDateWindowAnchor={setDateWindowAnchor}
                  onChooseRoom={chooseRoom}
                  onChooseStart={chooseStart}
                  onChooseDuration={chooseDuration}
                  onGuidelines={openGuidelines}
                  onContinue={openDetails}
                />
              </motion.div>
            )}
            {page === "manage" && (
              <motion.section
                id="manage-view"
                key="manage-page"
                data-motion-page="manage"
                variants={variants.page}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                {routeLoading ? (
                  <RouteLoading reduced={reduced} />
                ) : managedBooking ? (
                  <AnimatePresence mode="wait">
                    <Confirmation
                      item={managedBooking}
                      token={managementToken}
                      reduced={reduced}
                      variants={variants}
                      cancelling={cancelling}
                      copied={copied}
                      onCopy={() => void copyPrivateLink()}
                      onEdit={() => void editBooking()}
                      onCancel={() => void cancelBooking()}
                      onNew={() => resetBookingFlow("push")}
                    />
                  </AnimatePresence>
                ) : (
                  <MissingBooking
                    message={managedError}
                    reduced={reduced}
                    variants={variants}
                    onNew={() => resetBookingFlow("push")}
                  />
                )}
              </motion.section>
            )}
            {page === "service" && (
              <motion.section
                id="manage-view"
                key="service-page"
                data-motion-page="service"
                variants={variants.page}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <ServiceError
                  message={serviceError}
                  reduced={reduced}
                  variants={variants}
                />
              </motion.section>
            )}
          </AnimatePresence>
        </main>
      </div>
      <DetailsDrawer
        open={dialog === "details"}
        room={selectedRoom}
        selection={selection}
        busy={busy}
        availabilityLoading={availabilityLoading}
        availabilityError={availabilityError}
        draft={draft}
        editing={Boolean(editingToken)}
        submitting={submitting}
        formError={formError}
        reduced={reduced}
        variants={variants}
        onDraft={setDraft}
        onChooseDate={(date) => {
          if (isDateAllowed(date)) setDateWindowAnchor(date);
          void chooseDate(date);
        }}
        onChooseStart={chooseStart}
        onChooseDuration={chooseDuration}
        onRetryAvailability={() =>
          void loadAvailability(selection.date, editingToken)
        }
        onClose={closeDetails}
        onSubmit={(event) => void confirmBooking(event)}
      />
      <GuidelinesDrawer
        open={dialog === "guidelines"}
        room={guidelinesRoom}
        reduced={reduced}
        variants={variants}
        onClose={closeGuidelines}
      />
      <AnimatePresence initial={false}>
        {toast && (
          <motion.div
            className="toast"
            id="toast"
            role="status"
            aria-live="polite"
            key={toast.id}
            variants={variants.toast}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("The application root is missing.");
createRoot(root).render(<App />);
