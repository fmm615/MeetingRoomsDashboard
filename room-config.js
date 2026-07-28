"use strict";

const ROOM_CONFIGURATIONS = [
  {
    id: "boardroom",
    slug: "meeting-room",
    name: "Meeting Room",
    location: "",
    purpose: "Standard meetings for 2–7 people.",
    compactDescription: "Standard meetings for 2–7 people.",
    recommendedUses: [
      "Group working meetings",
      "Team meetings",
      "Client meetings",
      "Interviews",
      "Onboarding sessions",
      "Group discussions"
    ],
    guidelines: [
      "Not intended for solo work.",
      "Not intended for long individual calls.",
      "Use desk-side meetings or Quiet Pods for quick 1:1 meetings when possible.",
      "Keep the room clean.",
      "Remove personal items after the booking."
    ],
    bookingIncrementMinutes: 15,
    minimumDurationMinutes: 15,
    maximumDurationMinutes: 120,
    allowedDurationsMinutes: null,
    capacityLabel: "2–7 people",
    maximumCapacity: 7,
    isActive: true
  },
  {
    id: "meeting-a",
    slug: "standing-workstations",
    name: "Standing Workstations",
    location: "Middle Meeting Room",
    purpose: "Quick tasks, fast check-ins, and short 1:1 conversations.",
    compactDescription: "Quick tasks, fast check-ins, and short 1:1s.",
    recommendedUses: [
      "Quick tasks",
      "Brief check-ins",
      "Short 1:1 conversations",
      "Temporary standing work"
    ],
    guidelines: [
      "Not intended for full meetings.",
      "Not intended for long calls.",
      "Standing use is preferred.",
      "Do not remain there for extended work.",
      "Return to the main desk after use.",
      "Keep the area clear and tidy."
    ],
    bookingIncrementMinutes: 15,
    minimumDurationMinutes: 15,
    maximumDurationMinutes: 60,
    allowedDurationsMinutes: [15, 30, 45, 60],
    capacityLabel: "Up to 2 people",
    maximumCapacity: 2,
    isActive: true
  },
  {
    id: "meeting-b",
    slug: "innovation-hub",
    name: "Innovation Hub",
    location: "",
    purpose: "Brainstorming, creativity, workshops, and strategy sessions.",
    compactDescription: "Brainstorming, workshops, creativity, and strategy.",
    recommendedUses: [
      "Brainstorming",
      "Creative sessions",
      "Workshops",
      "Strategy sessions",
      "Collaborative planning",
      "Energetic group discussions"
    ],
    guidelines: [
      "Intended for collaboration.",
      "Not intended for solo work.",
      "Furniture may be moved during the session.",
      "Furniture must be returned to its original position afterward.",
      "Clean whiteboards after use.",
      "Keep noise within a reasonable level.",
      "Remove sticky notes, papers, and materials after the session."
    ],
    bookingIncrementMinutes: 15,
    minimumDurationMinutes: 15,
    maximumDurationMinutes: 120,
    allowedDurationsMinutes: null,
    capacityLabel: "No fixed limit",
    maximumCapacity: null,
    isActive: true
  },
  {
    id: "quiet-pods",
    slug: "quiet-pods",
    name: "Quiet Pods",
    location: "",
    purpose: "Quick 1:1s, short internal conversations, focused work, calls, and meals.",
    compactDescription: "Quick 1:1s, focused work, short calls, and internal chats.",
    recommendedUses: [
      "Quick 1:1 meetings",
      "Short internal conversations",
      "Focused individual work",
      "1:1 Zoom calls",
      "Small conversations involving 2–3 people",
      "Short meal breaks"
    ],
    guidelines: [
      "Keep voice volume moderate.",
      "Meals are allowed.",
      "Clean the area fully after eating.",
      "Wipe the table before leaving.",
      "Do not remain longer when another person is waiting."
    ],
    bookingIncrementMinutes: 15,
    minimumDurationMinutes: 30,
    maximumDurationMinutes: 45,
    allowedDurationsMinutes: [30, 45],
    capacityLabel: "Up to 3 people",
    maximumCapacity: 3,
    isActive: true
  }
];

module.exports = { ROOM_CONFIGURATIONS };
