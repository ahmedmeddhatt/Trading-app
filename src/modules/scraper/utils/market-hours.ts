// Cairo is UTC+2 year-round (Egypt abolished DST in 2011)
const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000;

export interface MarketStatus {
  isOpen: boolean;
  isPreMarket: boolean; // 09:00–10:00 Cairo
  isPostMarket: boolean; // 14:30–17:00 Cairo
  isClosed: boolean; // 17:00–09:00 or weekend
  nextOpenMs: number; // ms until next market open (0 if currently open)
  closesInMs: number; // ms until market closes (0 if not open)
  label: string; // "Open" | "Pre-Market" | "Post-Market" | "Closed" | "Weekend"
}

// EGX trading days: Sunday(0)–Thursday(4); Friday(5) and Saturday(6) are weekend
const MARKET_OPEN_MIN = 10 * 60; // 600
const MARKET_CLOSE_MIN = 14 * 60 + 30; // 870
const PRE_MARKET_MIN = 9 * 60; // 540
const POST_MARKET_MIN = 17 * 60; // 1020

function getCairo(): { day: number; timeMin: number; sec: number } {
  // Shift UTC by +2h, then use getUTC* to get Cairo components
  const shifted = new Date(Date.now() + CAIRO_OFFSET_MS);
  const day = shifted.getUTCDay();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const sec = shifted.getUTCSeconds();
  return { day, timeMin: hour * 60 + minute, sec };
}

export function isWeekend(): boolean {
  const { day } = getCairo();
  return day === 5 || day === 6; // Friday or Saturday
}

export function isMarketOpen(): boolean {
  const { day, timeMin } = getCairo();
  return (
    day >= 0 &&
    day <= 4 &&
    timeMin >= MARKET_OPEN_MIN &&
    timeMin < MARKET_CLOSE_MIN
  );
}

export function getMarketStatus(): MarketStatus {
  const { day, timeMin, sec } = getCairo();
  const isWeekday = day >= 0 && day <= 4;

  const isOpen =
    isWeekday && timeMin >= MARKET_OPEN_MIN && timeMin < MARKET_CLOSE_MIN;
  const isPreMarket =
    isWeekday && timeMin >= PRE_MARKET_MIN && timeMin < MARKET_OPEN_MIN;
  const isPostMarket =
    isWeekday && timeMin >= MARKET_CLOSE_MIN && timeMin < POST_MARKET_MIN;
  const isClosed = !isOpen && !isPreMarket && !isPostMarket;

  let label: string;
  if (isOpen) label = 'Open';
  else if (isPreMarket) label = 'Pre-Market';
  else if (isPostMarket) label = 'Post-Market';
  else if (!isWeekday) label = 'Weekend';
  else label = 'Closed';

  const closesInMs = isOpen
    ? (MARKET_CLOSE_MIN - timeMin) * 60 * 1000 - sec * 1000
    : 0;

  return {
    isOpen,
    isPreMarket,
    isPostMarket,
    isClosed,
    nextOpenMs: calcNextOpenMs(day, timeMin, sec),
    closesInMs,
    label,
  };
}

function calcNextOpenMs(day: number, timeMin: number, sec: number): number {
  // Already open
  if (
    day >= 0 &&
    day <= 4 &&
    timeMin >= MARKET_OPEN_MIN &&
    timeMin < MARKET_CLOSE_MIN
  ) {
    return 0;
  }

  // Same weekday, before market open (pre-market or earlier)
  if (day >= 0 && day <= 4 && timeMin < MARKET_OPEN_MIN) {
    return (MARKET_OPEN_MIN - timeMin) * 60 * 1000 - sec * 1000;
  }

  // Post-market, closed, or weekend — find next market day at 10:00
  // day 0–3 (Sun–Wed) after close → next day (+1)
  // day 4 (Thu) after close       → Sunday (+3)
  // day 5 (Fri)                   → Sunday (+2)
  // day 6 (Sat)                   → Sunday (+1)
  const daysAhead = day === 4 ? 3 : day === 5 ? 2 : day === 6 ? 1 : 1;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const msUntilMidnight = (24 * 60 - timeMin) * 60 * 1000 - sec * 1000;
  return (
    msUntilMidnight + (daysAhead - 1) * MS_PER_DAY + MARKET_OPEN_MIN * 60 * 1000
  );
}
