// shopCatalog.js — the master list of cosmetic shop items.
//
// All items are COSMETIC ONLY. Nothing here can affect debate results, rank
// tokens, matchmaking, or grant any competitive advantage.
//
// Fields per item match the Firestore shopItems/{itemId} schema:
//   id, name, description, category, rarity, price, imageName, isAnimated,
//   rotationType ('daily' | 'weekly' | 'permanent'), isLimited, colorHex (optional),
//   bannerText (optional, badges), bannerColorHex (optional, badge gradient end)
//
// `permanent` items are always visible in the shop (not part of the rotation).
//
// `imageName` is an SF Symbol name the iOS client renders as the preview, so
// no binary art assets are required. `colorHex` tints frames / username colors.
//
// Price guidance: daily 20-60, weekly 75-180.

const RARITY = { COMMON: 'common', RARE: 'rare', EPIC: 'epic', LEGENDARY: 'legendary' };

const CATALOG = [
  // ── Daily items (rotationType: 'daily', price 20-60) ──────────────────
  // Profile frames
  { id: 'frame_classic_gold', name: 'Classic Gold Frame', description: 'A clean champagne-gold ring for your avatar.', category: 'frame', rarity: RARITY.COMMON, price: 25, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#C9A962' },
  { id: 'frame_emerald', name: 'Emerald Frame', description: 'A polished emerald avatar ring.', category: 'frame', rarity: RARITY.RARE, price: 40, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#2FB67A' },
  { id: 'frame_crimson', name: 'Crimson Frame', description: 'A bold crimson avatar ring.', category: 'frame', rarity: RARITY.RARE, price: 40, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#D95C5C' },
  { id: 'frame_sapphire', name: 'Sapphire Frame', description: 'A cool sapphire avatar ring.', category: 'frame', rarity: RARITY.COMMON, price: 25, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#5C8AD9' },

  // Username colors
  { id: 'color_gold', name: 'Gold Name', description: 'Show your username in champagne gold.', category: 'usernameColor', rarity: RARITY.COMMON, price: 20, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#C9A962' },
  { id: 'color_violet', name: 'Violet Name', description: 'A rich violet username color.', category: 'usernameColor', rarity: RARITY.RARE, price: 35, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#9B6CE0' },
  { id: 'color_teal', name: 'Teal Name', description: 'A crisp teal username color.', category: 'usernameColor', rarity: RARITY.COMMON, price: 20, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#39C0B3' },

  // Reaction packs
  { id: 'reactions_fire', name: 'Fire Reactions', description: 'A pack of fiery debate reactions.', category: 'reaction', rarity: RARITY.RARE, price: 45, imageName: 'flame.fill', isAnimated: false, rotationType: 'daily', isLimited: false },
  { id: 'reactions_classic', name: 'Classic Reactions', description: 'Thumbs, claps, and more.', category: 'reaction', rarity: RARITY.COMMON, price: 30, imageName: 'hand.thumbsup.fill', isAnimated: false, rotationType: 'daily', isLimited: false },

  // Debate-room backgrounds
  { id: 'bg_midnight', name: 'Midnight Arena', description: 'A deep midnight debate-room backdrop.', category: 'background', rarity: RARITY.RARE, price: 50, imageName: 'moon.stars.fill', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#1A2138' },
  { id: 'bg_sunrise', name: 'Sunrise Arena', description: 'A warm sunrise debate-room backdrop.', category: 'background', rarity: RARITY.COMMON, price: 35, imageName: 'sunrise.fill', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#E0915C' },

  // Entrance effects
  { id: 'entrance_spark', name: 'Spark Entrance', description: 'A subtle spark when you enter a debate.', category: 'entranceEffect', rarity: RARITY.RARE, price: 55, imageName: 'sparkle', isAnimated: false, rotationType: 'daily', isLimited: false },

  // Profile badges
  { id: 'badge_debater', name: 'Debater Badge', description: 'A badge for the dedicated debater.', category: 'badge', rarity: RARITY.COMMON, price: 25, imageName: 'rosette', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#C9A962', bannerText: '#1 Debater', bannerColorHex: '#8B7340' },
  { id: 'badge_thinker', name: 'Thinker Badge', description: 'A badge for the deep thinker.', category: 'badge', rarity: RARITY.RARE, price: 40, imageName: 'brain.head.profile', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#5C8AD9', bannerText: 'Deep Thinker', bannerColorHex: '#3A5A9E' },
  { id: 'frame_platinum', name: 'Platinum Frame', description: 'A sleek platinum avatar ring.', category: 'frame', rarity: RARITY.COMMON, price: 30, imageName: 'circle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#B8C4D4' },
  { id: 'color_rose', name: 'Rose Name', description: 'A soft rose username color.', category: 'usernameColor', rarity: RARITY.COMMON, price: 22, imageName: 'textformat', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#E07A9A' },
  { id: 'reactions_sparkle', name: 'Spark Reactions', description: 'Sparkles, stars, and hype reactions.', category: 'reaction', rarity: RARITY.COMMON, price: 38, imageName: 'sparkles', isAnimated: false, rotationType: 'daily', isLimited: false },
  { id: 'badge_spark', name: 'Spark Badge', description: 'A badge that glows with Spark energy.', category: 'badge', rarity: RARITY.COMMON, price: 18, imageName: 'sparkle', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#7EC8FF', bannerText: 'Spark Master', bannerColorHex: '#4A9AD4' },
  { id: 'badge_coolest', name: 'Coolest Badge', description: 'For debaters with unmatched style.', category: 'badge', rarity: RARITY.RARE, price: 42, imageName: 'sunglasses.fill', isAnimated: false, rotationType: 'daily', isLimited: false, colorHex: '#6B5CE7', bannerText: 'Coolest Debater', bannerColorHex: '#4538A8' },
  { id: 'entrance_wave', name: 'Wave Entrance', description: 'A friendly wave when you join a debate.', category: 'entranceEffect', rarity: RARITY.COMMON, price: 48, imageName: 'hand.wave.fill', isAnimated: false, rotationType: 'daily', isLimited: false },

  // ── Permanent (always available in the shop) ───────────────────────────
  { id: 'badge_owner', name: "Owner's Badge", description: 'An exclusive badge for TrendSpark owners — yours for a single Spark.', category: 'badge', rarity: RARITY.LEGENDARY, price: 1, imageName: 'crown.fill', isAnimated: false, rotationType: 'permanent', isLimited: false, colorHex: '#FFD700', bannerText: 'TrendSpark Owner', bannerColorHex: '#B8860B' },

  // ── Weekly items (rotationType: 'weekly', price 75-180) ───────────────
  { id: 'frame_aurora_anim', name: 'Aurora Frame', description: 'An animated aurora avatar ring that shimmers.', category: 'frame', rarity: RARITY.EPIC, price: 120, imageName: 'circle.hexagongrid.fill', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#7AE0C2' },
  { id: 'frame_phoenix_anim', name: 'Phoenix Frame', description: 'A legendary animated flame ring.', category: 'frame', rarity: RARITY.LEGENDARY, price: 180, imageName: 'flame.circle.fill', isAnimated: true, rotationType: 'weekly', isLimited: true, colorHex: '#FF7A3D' },
  { id: 'bg_nebula_anim', name: 'Nebula Arena', description: 'An animated nebula debate-room backdrop.', category: 'background', rarity: RARITY.EPIC, price: 130, imageName: 'sparkles', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#3B2A66' },
  { id: 'victory_confetti', name: 'Confetti Victory', description: 'Celebrate wins with a confetti burst.', category: 'victoryAnimation', rarity: RARITY.EPIC, price: 110, imageName: 'party.popper.fill', isAnimated: true, rotationType: 'weekly', isLimited: false },
  { id: 'victory_crown', name: 'Crown Victory', description: 'A legendary golden crown victory animation.', category: 'victoryAnimation', rarity: RARITY.LEGENDARY, price: 175, imageName: 'crown.fill', isAnimated: true, rotationType: 'weekly', isLimited: true, colorHex: '#C9A962' },
  { id: 'badge_champion', name: 'Champion Badge', description: 'A rare champion badge for your profile.', category: 'badge', rarity: RARITY.EPIC, price: 95, imageName: 'trophy.fill', isAnimated: false, rotationType: 'weekly', isLimited: false, colorHex: '#C9A962', bannerText: 'Champion', bannerColorHex: '#9A7B3A' },
  { id: 'entrance_lightning', name: 'Lightning Entrance', description: 'A limited dramatic lightning entrance.', category: 'entranceEffect', rarity: RARITY.LEGENDARY, price: 160, imageName: 'bolt.fill', isAnimated: true, rotationType: 'weekly', isLimited: true },
  { id: 'theme_obsidian', name: 'Obsidian Theme', description: 'A sleek obsidian profile theme.', category: 'background', rarity: RARITY.RARE, price: 85, imageName: 'square.stack.3d.up.fill', isAnimated: false, rotationType: 'weekly', isLimited: false, colorHex: '#15151A' },
  { id: 'color_prismatic', name: 'Prismatic Name', description: 'A vivid prismatic username color.', category: 'usernameColor', rarity: RARITY.EPIC, price: 90, imageName: 'textformat', isAnimated: false, rotationType: 'weekly', isLimited: false, colorHex: '#B06CFF' },
  { id: 'frame_diamond', name: 'Diamond Frame', description: 'A brilliant diamond-cut avatar ring.', category: 'frame', rarity: RARITY.EPIC, price: 145, imageName: 'diamond.fill', isAnimated: true, rotationType: 'weekly', isLimited: false, colorHex: '#E8F4FF' },
  { id: 'badge_legend', name: 'Legend Badge', description: 'For debaters who never back down.', category: 'badge', rarity: RARITY.LEGENDARY, price: 125, imageName: 'star.circle.fill', isAnimated: false, rotationType: 'weekly', isLimited: false, colorHex: '#FFB347', bannerText: 'Legend', bannerColorHex: '#CC7A1A' }
];

module.exports = { CATALOG, RARITY };
