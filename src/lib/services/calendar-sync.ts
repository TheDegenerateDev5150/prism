import { db } from '@/lib/db/client';
import { calendarSources, events } from '@/lib/db/schema';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import {
  fetchCalendarEvents,
  fetchCalendarList,
  refreshAccessToken,
  convertGoogleEventToInternal,
  TokenRevokedError,
  type GoogleCalendarEvent,
} from '@/lib/integrations/google-calendar';
import { decrypt, encrypt } from '@/lib/utils/crypto';

/**
 * Check if token needs refresh (within 5 minutes of expiry)
 */
function tokenNeedsRefresh(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  return expiresAt <= fiveMinutesFromNow;
}

/**
 * Sync events from a single Google Calendar source
 */
export async function syncGoogleCalendarSource(
  sourceId: string,
  options: {
    timeMin?: Date;
    timeMax?: Date;
  } = {}
): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;

  // Fetch the calendar source
  const source = await db.query.calendarSources.findFirst({
    where: eq(calendarSources.id, sourceId),
  });

  if (!source) {
    return { synced: 0, errors: ['Calendar source not found'] };
  }

  if (source.provider !== 'google') {
    return { synced: 0, errors: ['Not a Google Calendar source'] };
  }

  if (!source.accessToken) {
    return { synced: 0, errors: ['No access token available'] };
  }

  let accessToken: string;
  try {
    accessToken = decrypt(source.accessToken);
  } catch (error) {
    return { synced: 0, errors: [`Failed to decrypt access token (may need re-authentication): ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (tokenNeedsRefresh(source.tokenExpiresAt)) {
    if (!source.refreshToken) {
      return { synced: 0, errors: ['Token expired and no refresh token available'] };
    }

    try {
      const refreshToken = decrypt(source.refreshToken);
      const newTokens = await refreshAccessToken(refreshToken);
      accessToken = newTokens.access_token;

      await db
        .update(calendarSources)
        .set({
          accessToken: encrypt(newTokens.access_token),
          refreshToken: newTokens.refresh_token ? encrypt(newTokens.refresh_token) : source.refreshToken,
          tokenExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
          updatedAt: new Date(),
        })
        .where(eq(calendarSources.id, sourceId));
    } catch (error) {
      // If token is revoked/expired, mark as needing re-authentication
      if (error instanceof TokenRevokedError) {
        await db
          .update(calendarSources)
          .set({
            syncErrors: {
              needsReauth: true,
              lastError: 'Token expired or revoked. Please re-authenticate.',
              timestamp: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(calendarSources.id, sourceId));
        return { synced: 0, errors: ['Token expired or revoked. Re-authentication required.'] };
      }
      return { synced: 0, errors: [`Failed to refresh token: ${error}`] };
    }
  }

  // Set default time range (30 days ago to 30 days from now)
  const timeMin = options.timeMin || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const timeMax = options.timeMax || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Fetch events from Google
  let googleEvents: GoogleCalendarEvent[];
  try {
    googleEvents = await fetchCalendarEvents(accessToken, source.sourceCalendarId, {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
  } catch (error) {
    const errorStr = String(error);
    const is404 = errorStr.includes('404') || errorStr.includes('Not Found');

    // Track consecutive failures instead of immediately disabling
    const prevErrors = (source.syncErrors as Record<string, unknown>) || {};
    const prevFailures = (typeof prevErrors.consecutiveFailures === 'number' ? prevErrors.consecutiveFailures : 0);
    const consecutiveFailures = prevFailures + 1;
    const DISABLE_THRESHOLD = 3; // Only auto-disable after 3 consecutive 404s

    const shouldAutoDisable = is404
      && consecutiveFailures >= DISABLE_THRESHOLD
      && !prevErrors.userOverride; // Never auto-disable if user manually re-enabled

    await db
      .update(calendarSources)
      .set({
        ...(shouldAutoDisable ? { enabled: false, showInEventModal: false } : {}),
        syncErrors: {
          lastError: is404
            ? `Calendar not found in Google (404). Failure ${consecutiveFailures}/${DISABLE_THRESHOLD}.`
            : errorStr,
          consecutiveFailures,
          is404,
          ...(shouldAutoDisable ? { autoDisabled: true, autoDisabledAt: new Date().toISOString() } : {}),
          ...(prevErrors.userOverride ? { userOverride: true } : {}),
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(calendarSources.id, sourceId));

    return { synced: 0, errors: [`Failed to fetch events: ${error}`] };
  }

  // Build set of Google event IDs for deletion cleanup (excluding cancelled)
  const googleEventIds = new Set<string>();

  // Process each event using upsert to prevent duplicates
  for (const googleEvent of googleEvents) {
    try {
      // Skip cancelled events (deleted recurring instances)
      if (googleEvent.status === 'cancelled') continue;

      googleEventIds.add(googleEvent.id);
      const internalEvent = convertGoogleEventToInternal(googleEvent, sourceId);

      // Use upsert (ON CONFLICT) to prevent race condition duplicates
      await db
        .insert(events)
        .values({
          calendarSourceId: sourceId,
          externalEventId: internalEvent.externalEventId,
          title: internalEvent.title,
          description: internalEvent.description,
          location: internalEvent.location,
          startTime: internalEvent.startTime,
          endTime: internalEvent.endTime,
          allDay: internalEvent.allDay,
          recurring: internalEvent.recurring,
          recurrenceRule: internalEvent.recurrenceRule,
          lastSynced: new Date(),
        })
        .onConflictDoUpdate({
          target: [events.calendarSourceId, events.externalEventId],
          set: {
            title: internalEvent.title,
            description: internalEvent.description,
            location: internalEvent.location,
            startTime: internalEvent.startTime,
            endTime: internalEvent.endTime,
            allDay: internalEvent.allDay,
            recurring: internalEvent.recurring,
            recurrenceRule: internalEvent.recurrenceRule,
            lastSynced: new Date(),
            updatedAt: new Date(),
          },
        });

      synced++;
    } catch (error) {
      errors.push(`Failed to sync event ${googleEvent.id}: ${error}`);
    }
  }

  // Delete events that exist in Prism but were removed from Google
  // (Google is source of truth for synced events; cancelled events excluded above)

  // Find Prism events for this source that have an external_event_id
  // but are no longer in Google (within the sync date range)
  const prismEventsToCheck = await db.query.events.findMany({
    where: and(
      eq(events.calendarSourceId, sourceId),
      gte(events.startTime, timeMin),
      lte(events.startTime, timeMax)
    ),
  });

  for (const prismEvent of prismEventsToCheck) {
    // Only delete if it has an external_event_id (was synced) but is no longer in Google
    if (prismEvent.externalEventId && !googleEventIds.has(prismEvent.externalEventId)) {
      await db.delete(events).where(eq(events.id, prismEvent.id));
    }
  }

  // Update last synced timestamp (preserve userOverride so sync won't auto-disable)
  const currentErrors = (source.syncErrors as Record<string, unknown>) || {};
  await db
    .update(calendarSources)
    .set({
      lastSynced: new Date(),
      syncErrors: currentErrors.userOverride ? { userOverride: true } : null,
      updatedAt: new Date(),
    })
    .where(eq(calendarSources.id, sourceId));

  return { synced, errors };
}

/**
 * Sync all enabled Google Calendar sources
 */
export async function syncAllGoogleCalendars(
  options: {
    timeMin?: Date;
    timeMax?: Date;
  } = {}
): Promise<{ total: number; errors: string[] }> {
  const allErrors: string[] = [];
  let total = 0;

  // Get all enabled Google Calendar sources
  const sources = await db.query.calendarSources.findMany({
    where: and(
      eq(calendarSources.provider, 'google'),
      eq(calendarSources.enabled, true)
    ),
  });

  // Update showInEventModal based on actual Google accessRole.
  // Group sources by their refresh token to handle multiple Google accounts.
  // Each unique refresh token represents a different Google account.
  const tokenGroups = new Map<string, typeof sources>();
  for (const source of sources) {
    if (!source.refreshToken) continue;
    const key = source.refreshToken; // Encrypted token as grouping key
    const group = tokenGroups.get(key) || [];
    group.push(source);
    tokenGroups.set(key, group);
  }

  // Build a combined role map across all Google accounts
  const combinedRoleMap = new Map<string, string>();
  const checkedSourceIds = new Set<string>();

  for (const [, group] of tokenGroups) {
    const representative = group[0];
    if (!representative?.accessToken) continue;

    try {
      let accessToken = decrypt(representative.accessToken);
      if (tokenNeedsRefresh(representative.tokenExpiresAt) && representative.refreshToken) {
        const refreshToken = decrypt(representative.refreshToken);
        const newTokens = await refreshAccessToken(refreshToken);
        accessToken = newTokens.access_token;
      }
      const googleCalendars = await fetchCalendarList(accessToken);
      for (const cal of googleCalendars) {
        combinedRoleMap.set(cal.id, cal.accessRole);
      }
      for (const s of group) {
        checkedSourceIds.add(s.id);
      }
    } catch (error) {
      console.error(`[Sync] Failed to fetch calendar list for account group:`, error);
    }
  }

  // Now check each source against the combined map
  for (const source of sources) {
    if (!checkedSourceIds.has(source.id)) continue;

    const role = combinedRoleMap.get(source.sourceCalendarId);
    if (role === undefined) {
      // Calendar no longer in any connected Google account
      const prevErrors = (source.syncErrors as Record<string, unknown>) || {};
      const prevFailures = (typeof prevErrors.consecutiveNotFound === 'number' ? prevErrors.consecutiveNotFound : 0);
      const consecutiveNotFound = prevFailures + 1;
      const DISABLE_THRESHOLD = 3;
      const shouldAutoDisable = consecutiveNotFound >= DISABLE_THRESHOLD && !prevErrors.userOverride;

      await db
        .update(calendarSources)
        .set({
          ...(shouldAutoDisable ? { enabled: false, showInEventModal: false } : {}),
          syncErrors: {
            lastError: `Calendar not found in Google. Check ${consecutiveNotFound}/${DISABLE_THRESHOLD}.`,
            consecutiveNotFound,
            ...(shouldAutoDisable ? { autoDisabled: true, autoDisabledAt: new Date().toISOString() } : {}),
            ...(prevErrors.userOverride ? { userOverride: true } : {}),
            timestamp: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(calendarSources.id, source.id));
      continue;
    }
    // Calendar found — clear any not-found counters (preserve userOverride)
    const prevErrors = (source.syncErrors as Record<string, unknown>) || {};
    if (prevErrors.consecutiveNotFound) {
      await db
        .update(calendarSources)
        .set({
          syncErrors: prevErrors.userOverride ? { userOverride: true } : null,
          updatedAt: new Date(),
        })
        .where(eq(calendarSources.id, source.id));
    }
    const isWritable = role === 'writer' || role === 'owner';
    if (source.showInEventModal !== isWritable) {
      await db
        .update(calendarSources)
        .set({ showInEventModal: isWritable, updatedAt: new Date() })
        .where(eq(calendarSources.id, source.id));
    }
  }

  // Sync each source (catch errors per-source so one bad calendar doesn't crash all)
  for (const source of sources) {
    try {
      const result = await syncGoogleCalendarSource(source.id, options);
      total += result.synced;
      allErrors.push(...result.errors);
    } catch (error) {
      const errorMsg = `Failed to sync calendar "${source.dashboardCalendarName}": ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[Sync] ${errorMsg}`);
      allErrors.push(errorMsg);
    }
  }

  return { total, errors: allErrors };
}

/**
 * Get all events for a date range from the database
 */
export async function getEventsForDateRange(
  startDate: Date,
  endDate: Date
): Promise<typeof events.$inferSelect[]> {
  return db.query.events.findMany({
    where: and(
      gte(events.startTime, startDate),
      lte(events.startTime, endDate)
    ),
    orderBy: (events, { asc }) => [asc(events.startTime)],
    with: {
      calendarSource: true,
    },
  });
}

/**
 * Get all calendar sources with their sync status
 */
export async function getCalendarSourcesWithStatus() {
  return db.query.calendarSources.findMany({
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
  });
}


// ====================================================================
// CalDAV Sync
// ====================================================================

import { fetchCalDAVEvents, fetchCalDAVTasks, type CalDAVConnectionConfig } from '@/lib/integrations/caldav';
import { tasks } from '@/lib/db/schema';

/**
 * Sync events from a single CalDAV calendar source.
 */
export async function syncCalDAVCalendarSource(
  sourceId: string,
  options: { timeMin?: Date; timeMax?: Date } = {}
): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;

  const source = await db.query.calendarSources.findFirst({
    where: eq(calendarSources.id, sourceId),
  });

  if (!source || source.provider !== 'caldav') {
    return { synced: 0, errors: ['Not a CalDAV source'] };
  }

  if (!source.accessToken) {
    return { synced: 0, errors: ['No credentials available'] };
  }

  let password: string;
  try {
    password = decrypt(source.accessToken);
  } catch {
    return { synced: 0, errors: ['Failed to decrypt credentials — may need to reconnect'] };
  }

  const config = source.syncErrors as CalDAVConnectionConfig | null;
  if (!config?.serverUrl || !config?.username) {
    return { synced: 0, errors: ['Missing CalDAV connection config'] };
  }

  const timeMin = options.timeMin || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const timeMax = options.timeMax || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  try {
    const caldavEvents = await fetchCalDAVEvents(
      config.serverUrl,
      config.username,
      password,
      source.sourceCalendarId,
      timeMin,
      timeMax,
    );

    // Upsert events
    for (const event of caldavEvents) {
      const existing = await db.query.events.findFirst({
        where: and(
          eq(events.calendarSourceId, sourceId),
          eq(events.externalEventId, event.uid),
        ),
      });

      const eventData = {
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        color: event.color || source.color,
        recurring: event.recurring,
        recurrenceRule: event.recurrenceRule,
        calendarSourceId: sourceId,
        externalEventId: event.uid,
        updatedAt: new Date(),
      };

      if (existing) {
        await db.update(events)
          .set(eventData)
          .where(eq(events.id, existing.id));
      } else {
        await db.insert(events).values(eventData);
      }

      synced++;
    }

    // Clean up events that no longer exist upstream
    const upstreamUids = new Set(caldavEvents.map(e => e.uid));
    const localEvents = await db.query.events.findMany({
      where: and(
        eq(events.calendarSourceId, sourceId),
        gte(events.startTime, timeMin),
        lte(events.startTime, timeMax),
      ),
    });

    for (const local of localEvents) {
      if (local.externalEventId && !upstreamUids.has(local.externalEventId)) {
        await db.delete(events).where(eq(events.id, local.id));
      }
    }

    // Update sync timestamp
    await db.update(calendarSources)
      .set({ lastSynced: new Date(), syncErrors: config })
      .where(eq(calendarSources.id, sourceId));

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`CalDAV sync failed: ${msg}`);

    // Store error in syncErrors while preserving config
    await db.update(calendarSources)
      .set({
        syncErrors: { ...config, lastError: msg, lastErrorAt: new Date().toISOString() },
      })
      .where(eq(calendarSources.id, sourceId));
  }

  return { synced, errors };
}

/**
 * Sync all enabled CalDAV calendar sources.
 */
export async function syncAllCalDAVCalendars(
  options: { timeMin?: Date; timeMax?: Date } = {}
): Promise<{ total: number; errors: string[] }> {
  const allErrors: string[] = [];
  let total = 0;

  const sources = await db.query.calendarSources.findMany({
    where: and(
      eq(calendarSources.provider, 'caldav'),
      eq(calendarSources.enabled, true),
    ),
  });

  for (const source of sources) {
    // Sync events
    const eventResult = await syncCalDAVCalendarSource(source.id, options);
    total += eventResult.synced;
    allErrors.push(...eventResult.errors);

    // Also sync tasks (VTODO) from the same source
    const taskResult = await syncCalDAVTasks(source.id);
    total += taskResult.synced;
    allErrors.push(...taskResult.errors);
  }

  return { total, errors: allErrors };
}

/**
 * Sync tasks (VTODO) from a CalDAV calendar source into Prism tasks.
 */
export async function syncCalDAVTasks(
  sourceId: string,
): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;

  const source = await db.query.calendarSources.findFirst({
    where: eq(calendarSources.id, sourceId),
  });

  if (!source || source.provider !== 'caldav') {
    return { synced: 0, errors: ['Not a CalDAV source'] };
  }

  if (!source.accessToken) {
    return { synced: 0, errors: ['No credentials available'] };
  }

  let password: string;
  try {
    password = decrypt(source.accessToken);
  } catch {
    return { synced: 0, errors: ['Failed to decrypt credentials'] };
  }

  const config = source.syncErrors as CalDAVConnectionConfig | null;
  if (!config?.serverUrl || !config?.username) {
    return { synced: 0, errors: ['Missing CalDAV connection config'] };
  }

  try {
    const caldavTasks = await fetchCalDAVTasks(
      config.serverUrl,
      config.username,
      password,
      source.sourceCalendarId,
    );

    for (const task of caldavTasks) {
      const externalId = `caldav:${source.id}:${task.uid}`;

      const existing = await db.query.tasks.findFirst({
        where: eq(tasks.externalId, externalId),
      });

      const taskData = {
        title: task.title,
        description: task.description,
        dueDate: task.dueDate || null,
        completed: task.completed,
        completedAt: task.completedAt,
        priority: (task.priority || 'medium') as 'high' | 'medium' | 'low',
        category: task.categories[0] || null,
        externalId,
        externalUpdatedAt: new Date(),
        lastSynced: new Date(),
        updatedAt: new Date(),
      };

      if (existing) {
        await db.update(tasks)
          .set(taskData)
          .where(eq(tasks.id, existing.id));
      } else {
        await db.insert(tasks).values(taskData);
      }

      synced++;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    errors.push(`CalDAV task sync failed: ${msg}`);
  }

  return { synced, errors };
}
