const EASTERN_TIMEZONE = "America/New_York";
const MARKETPLACE_RELEASE_DAY = 2; // Tuesday
const MARKETPLACE_RELEASE_HOUR = 13; // 1 PM ET

type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getDateTimePartsInTimezone(
  date: Date,
  timeZone: string
): CalendarParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const valueByType: Record<string, string> = {};
  for (const part of parts) {
    valueByType[part.type] = part.value;
  }

  return {
    year: Number(valueByType.year),
    month: Number(valueByType.month),
    day: Number(valueByType.day),
    hour: Number(valueByType.hour),
    minute: Number(valueByType.minute),
    second: Number(valueByType.second),
  };
}

function addDaysToCalendarDate(
  year: number,
  month: number,
  day: number,
  days: number
) {
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let i = 0; i < 4; i++) {
    const guessParts = getDateTimePartsInTimezone(guess, timeZone);
    const guessAsUtc = Date.UTC(
      guessParts.year,
      guessParts.month - 1,
      guessParts.day,
      guessParts.hour,
      guessParts.minute,
      guessParts.second
    );

    const diffMs = targetAsUtc - guessAsUtc;
    if (diffMs === 0) {
      return guess;
    }

    guess = new Date(guess.getTime() + diffMs);
  }

  return guess;
}

export function getMarketplaceVisibleAtFromCreatedAt(createdAt: Date): Date {
  const createdAtEt = getDateTimePartsInTimezone(createdAt, EASTERN_TIMEZONE);
  const createdAtWeekday = new Date(
    Date.UTC(createdAtEt.year, createdAtEt.month - 1, createdAtEt.day)
  ).getUTCDay();

  const isBeforeReleaseTime =
    createdAtEt.hour < MARKETPLACE_RELEASE_HOUR ||
    (createdAtEt.hour === MARKETPLACE_RELEASE_HOUR &&
      createdAtEt.minute === 0 &&
      createdAtEt.second === 0 &&
      createdAt.getMilliseconds() === 0);

  let daysToAdd = (MARKETPLACE_RELEASE_DAY - createdAtWeekday + 7) % 7;
  if (daysToAdd === 0 && !isBeforeReleaseTime) {
    daysToAdd = 7;
  }

  const targetDate = addDaysToCalendarDate(
    createdAtEt.year,
    createdAtEt.month,
    createdAtEt.day,
    daysToAdd
  );

  return zonedDateTimeToUtc(
    targetDate.year,
    targetDate.month,
    targetDate.day,
    MARKETPLACE_RELEASE_HOUR,
    0,
    0,
    EASTERN_TIMEZONE
  );
}

export function isFractionVisibleOnMarketplace(
  createdAt: Date,
  now: Date = new Date()
): boolean {
  return now >= getMarketplaceVisibleAtFromCreatedAt(createdAt);
}

export function hasMarketplaceVisibilityWindow(
  createdAt: Date,
  expirationAt: Date
): boolean {
  const marketplaceVisibleAt = getMarketplaceVisibleAtFromCreatedAt(createdAt);
  return expirationAt.getTime() > marketplaceVisibleAt.getTime();
}
