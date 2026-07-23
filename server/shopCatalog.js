// shopCatalog.js — the master list of cosmetic shop items.
//
// All items are COSMETIC ONLY. Nothing here can affect debate results, rank
// tokens, matchmaking, or grant any competitive advantage.
//
// Fields per item match the Firestore shopItems/{itemId} schema:
//   id, name, description, category, rarity, price, imageName, isAnimated,
//   rotationType ('daily' | 'weekly' | 'special' | 'permanent'), isLimited,
//   colorHex (optional), secondaryColorHex (optional, gradients),
//   effect (optional: 'shimmer' | 'glow' | 'rainbow' | 'pulse'),
//   bannerText (optional, badges), bannerColorHex (optional, badge gradient end)
//
// Categories: frame, usernameColor, badge.
// (Victory celebrations were removed from the shop.)
//
// `special` items are ultra-rare finds that only occasionally appear in a
// user's personal daily shop.
//
// Price guidance: daily 20-60, weekly 75-180, special 200-500.

const RARITY = {
  COMMON: 'common',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary',
  MYTHIC: 'mythic'
};

const CATALOG = [
  // ── Daily items (rotationType: 'daily', price 20-60) ──────────────────
  // Profile frames
  { id: 'frame_classic_gold', name: 'Classic Gold Frame', description: 'A clean champagne-gold ring for your avatar.', category: 'frame', rarity: RARITY.COMMON, price: 25, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#C9A962' },
  { id: 'frame_emerald', name: 'Emerald Frame', description: 'A polished emerald avatar ring.', category: 'frame', rarity: RARITY.RARE, price: 40, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#2FB67A' },
  { id: 'frame_crimson', name: 'Crimson Frame', description: 'A bold crimson avatar ring.', category: 'frame', rarity: RARITY.RARE, price: 40, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#D95C5C' },
  { id: 'frame_sapphire', name: 'Sapphire Frame', description: 'A cool sapphire avatar ring.', category: 'frame', rarity: RARITY.COMMON, price: 25, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#5C8AD9' },
  { id: 'frame_platinum', name: 'Platinum Frame', description: 'A sleek platinum avatar ring.', category: 'frame', rarity: RARITY.COMMON, price: 30, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#B8C4D4' },
  { id: 'frame_amethyst', name: 'Amethyst Frame', description: 'A deep violet avatar ring with a soft inner glow.', category: 'frame', rarity: RARITY.RARE, price: 45, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#9B6CE0', effect: 'glow' },
  { id: 'frame_onyx', name: 'Onyx Frame', description: 'A jet-black ring edged in silver.', category: 'frame', rarity: RARITY.RARE, price: 42, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#3A3A44', secondaryColorHex: '#B8C4D4' },
  { id: 'frame_sunset', name: 'Sunset Frame', description: 'A warm orange-to-pink gradient ring.', category: 'frame', rarity: RARITY.RARE, price: 48, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#FF8C5A', secondaryColorHex: '#E05C9A' },

  // Username colors
  { id: 'color_gold', name: 'Gold Name', description: 'Show your username in champagne gold.', category: 'usernameColor', rarity: RARITY.COMMON, price: 20, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#C9A962' },
  { id: 'color_violet', name: 'Violet Name', description: 'A rich violet username color.', category: 'usernameColor', rarity: RARITY.RARE, price: 35, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#9B6CE0' },
  { id: 'color_teal', name: 'Teal Name', description: 'A crisp teal username color.', category: 'usernameColor', rarity: RARITY.COMMON, price: 20, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#39C0B3' },
  { id: 'color_rose', name: 'Rose Name', description: 'A soft rose username color.', category: 'usernameColor', rarity: RARITY.COMMON, price: 22, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#E07A9A' },
  { id: 'color_ember', name: 'Ember Name', description: 'A fiery orange-to-red gradient name.', category: 'usernameColor', rarity: RARITY.RARE, price: 40, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#FF9A3D', secondaryColorHex: '#E0453D' },
  { id: 'color_ocean', name: 'Ocean Name', description: 'A cool blue-to-teal gradient name.', category: 'usernameColor', rarity: RARITY.RARE, price: 40, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#4D8DE0', secondaryColorHex: '#39C0B3' },

  // Profile badges
  { id: 'badge_thinker', name: 'Thinker Badge', description: 'A badge for the deep thinker.', category: 'badge', rarity: RARITY.RARE, price: 40, imageName: 'brain.head.profile', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#5C8AD9', bannerText: 'Deep Thinker', bannerColorHex: '#3A5A9E' },
  { id: 'badge_spark', name: 'Spark Badge', description: 'A badge that glows with Spark energy.', category: 'badge', rarity: RARITY.COMMON, price: 18, imageName: 'sparkle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#7EC8FF', bannerText: 'Spark Master', bannerColorHex: '#4A9AD4' },
  { id: 'badge_coolest', name: 'Coolest Badge', description: 'For debaters with unmatched style.', category: 'badge', rarity: RARITY.RARE, price: 42, imageName: 'sunglasses.fill', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#6B5CE7', bannerText: 'Coolest Debater', bannerColorHex: '#4538A8' },
  { id: 'badge_wordsmith', name: 'Wordsmith Badge', description: 'For those whose words cut sharpest.', category: 'badge', rarity: RARITY.RARE, price: 38, imageName: 'quote.bubble.fill', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#E0915C', bannerText: 'Wordsmith', bannerColorHex: '#A8622F' },
  { id: 'badge_strategist', name: 'Strategist Badge', description: 'Always three arguments ahead.', category: 'badge', rarity: RARITY.RARE, price: 44, imageName: 'chess.board', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#39C0B3', bannerText: 'Strategist', bannerColorHex: '#1E7A70' },

  // ── Weekly items (rotationType: 'weekly', price 75-180) ───────────────
  { id: 'frame_aurora_anim', name: 'Aurora Frame', description: 'An animated aurora avatar ring that shimmers.', category: 'frame', rarity: RARITY.EPIC, price: 120, imageName: 'circle.hexagongrid.fill', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#7AE0C2', secondaryColorHex: '#7A8CE0', effect: 'shimmer' },
  { id: 'frame_phoenix_anim', name: 'Phoenix Frame', description: 'A legendary animated flame ring.', category: 'frame', rarity: RARITY.LEGENDARY, price: 180, imageName: 'flame.circle.fill', isAnimated: true, rotationType: 'weekly', isLimited: true, colorHex: '#FF7A3D', secondaryColorHex: '#FFD23D', effect: 'glow' },
  { id: 'frame_diamond', name: 'Diamond Frame', description: 'A brilliant diamond-cut avatar ring.', category: 'frame', rarity: RARITY.EPIC, price: 145, imageName: 'diamond.fill', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#E8F4FF', secondaryColorHex: '#9AC4E8', effect: 'shimmer' },
  { id: 'frame_royal_anim', name: 'Royal Frame', description: 'An animated royal purple-and-gold ring.', category: 'frame', rarity: RARITY.EPIC, price: 130, imageName: 'crown.fill', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#8A5CE0', secondaryColorHex: '#E0C25C', effect: 'shimmer' },
  { id: 'color_prismatic', name: 'Prismatic Name', description: 'A vivid prismatic username color.', category: 'usernameColor', rarity: RARITY.EPIC, price: 90, imageName: 'textformat', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#B06CFF', secondaryColorHex: '#5CC8E0', effect: 'shimmer' },
  { id: 'color_neon_pulse', name: 'Neon Pulse Name', description: 'An electric neon name that softly pulses.', category: 'usernameColor', rarity: RARITY.EPIC, price: 95, imageName: 'textformat', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#3DFFB0', secondaryColorHex: '#3DC8FF', effect: 'pulse' },
  { id: 'badge_champion', name: 'Champion Badge', description: 'A rare champion badge for your profile.', category: 'badge', rarity: RARITY.EPIC, price: 95, imageName: 'trophy.fill', isAnimated: false, rotationType: 'weekly', isLimited: false, colorHex: '#C9A962', bannerText: 'Champion', bannerColorHex: '#9A7B3A', effect: 'glow' },
  { id: 'badge_legend', name: 'Legend Badge', description: 'For debaters who never back down.', category: 'badge', rarity: RARITY.LEGENDARY, price: 125, imageName: 'star.circle.fill', isAnimated: false, rotationType: 'weekly', isLimited: false, colorHex: '#FFB347', bannerText: 'Legend', bannerColorHex: '#CC7A1A', effect: 'shimmer' },
  { id: 'badge_gladiator', name: 'Gladiator Badge', description: 'An animated badge forged for the arena of ideas.', category: 'badge', rarity: RARITY.EPIC, price: 110, imageName: 'shield.lefthalf.filled', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#D95C5C', bannerText: 'Gladiator', bannerColorHex: '#8A2E2E', effect: 'shimmer' },

  // ── Special items (rotationType: 'special', price 200-500) ─────────────
  // Ultra-rare finds. Only occasionally appear in a user's personal daily
  // shop ("Rare Find" slot), so spotting one feels like an event.
  { id: 'frame_galaxy_mythic', name: 'Galaxy Frame', description: 'A mythic animated ring of swirling starlight. Almost never in stock.', category: 'frame', rarity: RARITY.MYTHIC, price: 450, imageName: 'sparkles', isAnimated: true, rotationType: 'special', isLimited: true, colorHex: '#7A5CFF', secondaryColorHex: '#FF5CD0', effect: 'rainbow' },
  { id: 'frame_eclipse_mythic', name: 'Eclipse Frame', description: 'A mythic ring of molten gold circling the dark.', category: 'frame', rarity: RARITY.MYTHIC, price: 420, imageName: 'circle.circle.fill', isAnimated: true, rotationType: 'special', isLimited: true, colorHex: '#FFD23D', secondaryColorHex: '#1A1A24', effect: 'glow' },
  { id: 'color_aurora_mythic', name: 'Aurora Name', description: 'A mythic name that flows through the colors of the northern lights.', category: 'usernameColor', rarity: RARITY.MYTHIC, price: 380, imageName: 'textformat', isAnimated: true, rotationType: 'special', isLimited: true, colorHex: '#3DFFB0', secondaryColorHex: '#B06CFF', effect: 'rainbow' },
  { id: 'badge_immortal_mythic', name: 'Immortal Badge', description: 'A mythic badge reserved for the rarest of debaters.', category: 'badge', rarity: RARITY.MYTHIC, price: 500, imageName: 'laurel.leading', isAnimated: true, rotationType: 'special', isLimited: true, colorHex: '#FF5CD0', bannerText: 'Immortal', bannerColorHex: '#7A1A5C', effect: 'rainbow' },
  { id: 'badge_founder_gold', name: 'Golden Founder Badge', description: 'A legendary badge dipped in pure gold, with a moving sheen.', category: 'badge', rarity: RARITY.LEGENDARY, price: 260, imageName: 'medal.fill', isAnimated: true, rotationType: 'special', isLimited: true, colorHex: '#FFD700', bannerText: 'Golden Founder', bannerColorHex: '#8A6A00', effect: 'shimmer' },

  // ── One-of-one (oneOfOne: true) ─────────────────────────────────────────
  // Exactly ONE player in the world can ever own this. The purchase endpoint
  // stamps `ownedBy` on the shopItems doc; after that it's sold out forever.
  { id: 'badge_the_one', name: 'The One', description: 'A one-of-one crown badge. Only a single debater in the world will ever wear it.', category: 'badge', rarity: RARITY.MYTHIC, price: 1000000, imageName: 'crown.fill', isAnimated: true, rotationType: 'special', isLimited: true, oneOfOne: true, colorHex: '#FFD700', secondaryColorHex: '#FF5CD0', bannerText: 'The One', bannerColorHex: '#5C1A7A', effect: 'rainbow' }
];

module.exports = { CATALOG, RARITY };
